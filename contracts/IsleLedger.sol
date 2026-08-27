// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * ============================================================================
 *  Isle Ledger Deeds  —  Reel Fortune 3D
 * ============================================================================
 *
 *  Sertifikat pencapaian SOULBOUND (non-transferable) untuk game voxel
 *  "Reel Fortune 3D".
 *
 *  DESAIN SENGAJA: token ini TIDAK BISA DIPINDAHTANGANKAN.
 *  transferFrom / safeTransferFrom / approve / setApprovalForAll semuanya
 *  revert dengan error Soulbound().
 *
 *  Kenapa? Karena deed di sini hanyalah BUKTI PENCAPAIAN (misal "pernah
 *  menangkap ikan legendaris", "pernah menambang 1000 blok"). Kalau token
 *  bisa diperjualbelikan, ia otomatis punya harga pasar; dan begitu ada
 *  harga pasar, setiap mekanik acak di dalam game (roulette, kiosk, roll
 *  drop) berubah menjadi taruhan berhadiah uang nyata. Itu = judi uang
 *  nyata, ilegal di banyak yurisdiksi (termasuk Indonesia).
 *
 *  Dengan membuat deed soulbound:
 *    - tidak ada pasar sekunder  -> tidak ada harga  -> tidak ada nilai uang
 *    - hasil acak di game tidak pernah "membayar" apa pun yang bisa dicairkan
 *    - deed murni koleksi/reputasi, seperti trophy atau piagam
 *
 *  Kontrak ini juga TIDAK punya fungsi payable, TIDAK punya harga mint,
 *  TIDAK punya withdraw, dan TIDAK menyimpan dana apa pun. Tidak ada uang
 *  yang bisa masuk maupun keluar dari kontrak ini.
 *
 *  Tanpa dependency eksternal (tidak import OpenZeppelin). Semua helper
 *  (ECDSA recover, Base64, uint->string) ditulis di file ini.
 *
 * ============================================================================
 *  ALUR MINT
 * ============================================================================
 *
 *  1. Backend (server Node kita) menentukan bahwa pemain X berhak atas deed
 *     "deedId". Backend memegang private key 'signer'.
 *  2. Backend menandatangani digest:
 *
 *        digest = keccak256(abi.encodePacked(
 *            playerAddress,   // address (20 byte)
 *            deedId,          // string
 *            blockNo,         // uint256, nomor blok/step milestone in-game
 *            address(this),   // alamat kontrak ini  -> anti cross-contract replay
 *            block.chainid    // chain id             -> anti cross-chain replay
 *        ));
 *
 *     lalu menandatanganinya dengan prefix EIP-191 personal_sign:
 *
 *        eth_signed = keccak256("\x19Ethereum Signed Message:\n32" || digest)
 *
 *     (di ethers.js: wallet.signMessage(ethers.getBytes(digest)))
 *
 *  3. Pemain memanggil claim(deedId, blockNo, signature) DARI ALAMATNYA
 *     SENDIRI. Kontrak recover signature; kalau signer cocok, deed di-mint
 *     ke msg.sender. Signature tidak bisa dipakai ulang (mapping `used`),
 *     dan tokenId deterministik per (pemain, deedId) sehingga satu pemain
 *     tidak bisa punya deed yang sama dua kali.
 *
 *     Catatan: playerAddress diikat ke msg.sender, jadi signature milik
 *     pemain A tidak bisa dipakai pemain B.
 */
contract IsleLedgerDeeds {
    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @dev Dilempar oleh SEMUA operasi transfer/approval. Ini disengaja:
    ///      deed adalah bukti pencapaian, bukan barang dagangan. Tidak bisa
    ///      dijual, ditukar, dijaminkan, atau dijadikan taruhan.
    error Soulbound();

    error NotOwner();
    error ZeroAddress();
    error SignerNotSet();
    error BadSignatureLength();
    error InvalidSignature();
    error AlreadyClaimed();
    error NonexistentToken();
    error InvalidDeedId();

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    // Event ERC-721 standar. Transfer hanya pernah di-emit sekali per token,
    // yaitu saat mint (from = address(0)). Tidak akan pernah ada Transfer lain.
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    event DeedMinted(address indexed to, uint256 indexed tokenId, string deedId);
    event SignerChanged(address indexed previousSigner, address indexed newSigner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ------------------------------------------------------------------
    // Metadata
    // ------------------------------------------------------------------

    string public constant name = "Isle Ledger Deeds";
    string public constant symbol = "DEED";

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    struct Deed {
        string deedId;
        uint256 blockNo;
        uint64 mintedAt;
    }

    /// @notice Admin kontrak (boleh ganti signer / oper kepemilikan admin).
    address public owner;

    /// @notice Alamat backend yang berhak menandatangani klaim deed.
    address public signer;

    /// @notice Jumlah deed yang pernah di-mint (tidak pernah turun; tidak ada burn).
    uint256 public totalSupply;

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => Deed) private _deeds;

    /// @dev Daftar token per pemilik. Aman disimpan sebagai array append-only
    ///      justru karena token soulbound: tidak ada transfer, jadi tidak
    ///      pernah perlu penghapusan elemen.
    mapping(address => uint256[]) private _owned;

    /// @notice Anti-replay: digest yang sudah pernah dipakai untuk klaim.
    mapping(bytes32 => bool) public used;

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /// @param initialSigner alamat backend penandatangan. Boleh address(0)
    ///        lalu di-set belakangan lewat setSigner().
    constructor(address initialSigner) {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);

        signer = initialSigner;
        emit SignerChanged(address(0), initialSigner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ------------------------------------------------------------------
    // Admin (tidak ada fungsi payable / harga / withdraw di kontrak ini)
    // ------------------------------------------------------------------

    /// @notice Set alamat backend yang boleh menandatangani klaim.
    function setSigner(address newSigner) external onlyOwner {
        emit SignerChanged(signer, newSigner);
        signer = newSigner;
    }

    /// @notice Oper hak admin ke alamat lain.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ------------------------------------------------------------------
    // Claim / Mint
    // ------------------------------------------------------------------

    /// @notice tokenId deterministik per (pemain, deedId).
    function tokenIdFor(address player, string memory deedId) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(player, deedId)));
    }

    /// @notice Digest yang harus ditandatangani backend (sebelum prefix EIP-191).
    function claimDigest(address player, string memory deedId, uint256 blockNo)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(player, deedId, blockNo, address(this), block.chainid));
    }

    /// @notice Apakah `player` sudah memiliki deed dengan id tersebut.
    function hasDeed(address player, string memory deedId) external view returns (bool) {
        return _ownerOf[tokenIdFor(player, deedId)] != address(0);
    }

    /**
     * @notice Klaim deed memakai tanda tangan dari backend.
     * @dev    Dipanggil oleh PEMAIN sendiri; deed selalu di-mint ke msg.sender,
     *         jadi signature tidak bisa "dicuri" oleh alamat lain.
     * @param deedId    id deed, hanya [A-Z a-z 0-9 . _ - spasi], 1..32 karakter.
     *                  Dibatasi supaya aman ditanam langsung ke JSON & SVG
     *                  on-chain tanpa perlu escaping.
     * @param blockNo   nomor blok/milestone in-game yang dicatat di sertifikat.
     * @param signature 65 byte (r,s,v) hasil personal_sign backend.
     */
    function claim(string calldata deedId, uint256 blockNo, bytes calldata signature) external {
        address currentSigner = signer;
        if (currentSigner == address(0)) revert SignerNotSet();
        if (!_validDeedId(deedId)) revert InvalidDeedId();

        bytes32 digest = claimDigest(msg.sender, deedId, blockNo);
        if (used[digest]) revert AlreadyClaimed();

        bytes32 ethDigest = _toEthSignedMessageHash(digest);
        if (_recover(ethDigest, signature) != currentSigner) revert InvalidSignature();

        used[digest] = true;

        uint256 tokenId = tokenIdFor(msg.sender, deedId);
        // Pengaman kedua: satu pemain tidak boleh punya deed yang sama dua kali,
        // walaupun backend keliru menandatangani blockNo yang berbeda.
        if (_ownerOf[tokenId] != address(0)) revert AlreadyClaimed();

        _ownerOf[tokenId] = msg.sender;
        unchecked {
            _balanceOf[msg.sender] += 1;
            totalSupply += 1;
        }
        _owned[msg.sender].push(tokenId);
        _deeds[tokenId] = Deed({deedId: deedId, blockNo: blockNo, mintedAt: uint64(block.timestamp)});

        emit Transfer(address(0), msg.sender, tokenId);
        emit DeedMinted(msg.sender, tokenId, deedId);
    }

    // ------------------------------------------------------------------
    // ERC-721 (view)
    // ------------------------------------------------------------------

    function balanceOf(address account) external view returns (uint256) {
        if (account == address(0)) revert ZeroAddress();
        return _balanceOf[account];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address holder = _ownerOf[tokenId];
        if (holder == address(0)) revert NonexistentToken();
        return holder;
    }

    /// @notice Semua tokenId milik satu alamat. Murah & aman karena soulbound.
    function tokensOfOwner(address account) external view returns (uint256[] memory) {
        return _owned[account];
    }

    /// @notice Data mentah deed (dipakai UI game supaya tidak perlu parse tokenURI).
    function deedOf(uint256 tokenId)
        external
        view
        returns (string memory deedId, uint256 blockNo, uint64 mintedAt)
    {
        ownerOf(tokenId); // revert kalau token tidak ada
        Deed storage d = _deeds[tokenId];
        return (d.deedId, d.blockNo, d.mintedAt);
    }

    /**
     * @notice ERC-165.
     * @dev 0x01ffc9a7 = IERC165
     *      0x80ac58cd = IERC721
     *      0x5b5e139f = IERC721Metadata
     *      Enumerable (0x780e9d63) sengaja TIDAK diklaim; gunakan tokensOfOwner().
     */
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f;
    }

    // ------------------------------------------------------------------
    // SOULBOUND: semua jalur pemindahan kepemilikan diblokir
    // ------------------------------------------------------------------
    //
    // Sengaja revert, bukan sekadar no-op, supaya marketplace/wallet langsung
    // gagal keras dan tidak pernah menampilkan deed ini sebagai "listable".
    // Deed = bukti pencapaian pribadi. Tidak ada pasar sekunder, tidak ada
    // harga, tidak ada nilai uang -> tidak bisa jadi instrumen spekulasi
    // maupun taruhan.

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }

    /// @dev Selalu address(0): tidak ada approval yang mungkin diberikan.
    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId); // revert kalau token tidak ada
        return address(0);
    }

    /// @dev Selalu false: tidak ada operator yang mungkin diberi izin.
    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    // ------------------------------------------------------------------
    // tokenURI: JSON + SVG on-chain (data URI, tanpa IPFS / server metadata)
    // ------------------------------------------------------------------

    /// @dev Bagian statis kartu SVG (latar gelap + bingkai + ombak pixel).
    ///      Disimpan sebagai konstanta agar perakitan string di tokenURI tetap
    ///      dangkal dan kontrak bisa dikompilasi tanpa via-IR.
    string private constant _SVG_HEAD =
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320" shape-rendering="crispEdges">'
        '<rect width="320" height="320" fill="#070b10"/>'
        '<rect x="12" y="12" width="296" height="296" fill="#0f1720"/>'
        '<g fill="#1f6f8b">'
        '<rect x="12" y="12" width="296" height="8"/><rect x="12" y="300" width="296" height="8"/>'
        '<rect x="12" y="12" width="8" height="296"/><rect x="300" y="12" width="8" height="296"/>'
        "</g>"
        '<g fill="#12303d">'
        '<rect x="28" y="236" width="264" height="8"/>'
        '<rect x="44" y="228" width="24" height="8"/><rect x="100" y="228" width="24" height="8"/>'
        '<rect x="156" y="228" width="24" height="8"/><rect x="212" y="228" width="24" height="8"/>'
        '<rect x="28" y="252" width="264" height="4"/>'
        "</g>"
        '<g fill="#6fd3ef"><rect x="32" y="72" width="48" height="4"/></g>';

    string private constant _DESC =
        "Sertifikat pencapaian SOULBOUND dari Reel Fortune 3D. Non-transferable: "
        "tidak bisa dijual, ditukar, atau dijadikan taruhan. Murni bukti pencapaian in-game.";

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId); // revert kalau token tidak ada
        Deed storage d = _deeds[tokenId];
        string memory json = _json(d.deedId, d.blockNo, d.mintedAt);
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    function _json(string memory deedId, uint256 blockNo, uint64 mintedAt)
        internal
        pure
        returns (string memory)
    {
        string memory head = string(
            abi.encodePacked(
                '{"name":"Deed: ',
                deedId,
                '","description":"',
                _DESC,
                '","image":"data:image/svg+xml;base64,',
                Base64.encode(bytes(_svg(deedId, blockNo)))
            )
        );
        string memory attrs = string(
            abi.encodePacked(
                '","attributes":[{"trait_type":"Deed","value":"',
                deedId,
                '"},{"trait_type":"Block","value":',
                _toString(blockNo),
                '},{"trait_type":"Transferable","value":"No"},'
                '{"display_type":"date","trait_type":"Minted","value":',
                _toString(uint256(mintedAt))
            )
        );
        return string(abi.encodePacked(head, attrs, "}]}"));
    }

    /// @dev Kartu pixel gelap 320x320. shape-rendering=crispEdges supaya kotak
    ///      tetap tajam (gaya voxel/pixel seperti game-nya).
    function _svg(string memory deedId, uint256 blockNo) internal pure returns (string memory) {
        return string(abi.encodePacked(_SVG_HEAD, _svgText(deedId, blockNo), "</svg>"));
    }

    function _svgText(string memory deedId, uint256 blockNo) internal pure returns (string memory) {
        string memory a = string(
            abi.encodePacked(
                '<g font-family="monospace" font-weight="bold">'
                '<text x="32" y="56" font-size="13" fill="#6fd3ef">ISLE LEDGER // DEED</text>'
                '<text x="32" y="118" font-size="20" fill="#e8f3f7" textLength="256" lengthAdjust="spacingAndGlyphs">',
                deedId,
                "</text>"
            )
        );
        string memory b = string(
            abi.encodePacked(
                '<text x="32" y="152" font-size="12" fill="#8fa6b2">BLOCK ',
                _toString(blockNo),
                "</text>"
                '<text x="32" y="174" font-size="12" fill="#8fa6b2">SOULBOUND - NON TRANSFERABLE</text>'
                '<text x="32" y="284" font-size="11" fill="#4d6472">REEL FORTUNE 3D</text>'
                "</g>"
            )
        );
        return string(abi.encodePacked(a, b));
    }

    // ------------------------------------------------------------------
    // Helper: validasi deedId
    // ------------------------------------------------------------------

    /// @dev Hanya [A-Z a-z 0-9 . _ - spasi], panjang 1..32.
    ///      Membatasi charset = tidak ada kutip / < / > yang bisa merusak
    ///      (atau menyuntik sesuatu ke) JSON dan SVG on-chain.
    function _validDeedId(string memory s) internal pure returns (bool) {
        bytes memory b = bytes(s);
        if (b.length == 0 || b.length > 32) return false;
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            bool ok = (c >= 0x30 && c <= 0x39) // 0-9
                || (c >= 0x41 && c <= 0x5a) // A-Z
                || (c >= 0x61 && c <= 0x7a) // a-z
                || c == 0x2d // -
                || c == 0x5f // _
                || c == 0x2e // .
                || c == 0x20; // spasi
            if (!ok) return false;
        }
        return true;
    }

    // ------------------------------------------------------------------
    // Helper: ECDSA (ditulis sendiri, tanpa OpenZeppelin)
    // ------------------------------------------------------------------

    /// @dev Prefix EIP-191 versi personal_sign untuk payload 32 byte.
    function _toEthSignedMessageHash(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    /// @dev ecrecover + tolak signature malleable (s pada upper-half) dan v salah.
    function _recover(bytes32 hash, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) revert BadSignatureLength();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }

        // Beberapa signer memakai v = 0/1 alih-alih 27/28.
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignature();

        // EIP-2: tolak s di upper half order agar satu signature tidak punya
        // dua bentuk valid (anti-replay bentuk kedua).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert InvalidSignature();
        }

        address recovered = ecrecover(hash, v, r, s);
        if (recovered == address(0)) revert InvalidSignature();
        return recovered;
    }

    // ------------------------------------------------------------------
    // Helper: uint256 -> string
    // ------------------------------------------------------------------

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buf = new bytes(digits);
        while (value != 0) {
            digits--;
            buf[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buf);
    }
}

/**
 * @dev Base64 encoder minimal, ditulis sendiri (tanpa import). Dipakai hanya
 *      di fungsi `view` (tokenURI), jadi versi Solidity murni yang mudah
 *      dibaca lebih dipilih daripada versi assembly yang hemat gas.
 */
library Base64 {
    bytes internal constant TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function encode(bytes memory data) internal pure returns (string memory) {
        uint256 len = data.length;
        if (len == 0) return "";

        // Salin ke memory supaya bisa di-index (konstanta non-value type
        // tidak bisa di-index langsung).
        bytes memory table = TABLE;

        bytes memory out = new bytes(4 * ((len + 2) / 3));
        uint256 i = 0;
        uint256 j = 0;

        while (i + 3 <= len) {
            uint256 n = (uint256(uint8(data[i])) << 16) | (uint256(uint8(data[i + 1])) << 8)
                | uint256(uint8(data[i + 2]));
            out[j++] = table[(n >> 18) & 63];
            out[j++] = table[(n >> 12) & 63];
            out[j++] = table[(n >> 6) & 63];
            out[j++] = table[n & 63];
            i += 3;
        }

        uint256 rem = len - i;
        if (rem == 1) {
            uint256 n = uint256(uint8(data[i])) << 16;
            out[j++] = table[(n >> 18) & 63];
            out[j++] = table[(n >> 12) & 63];
            out[j++] = bytes1("=");
            out[j++] = bytes1("=");
        } else if (rem == 2) {
            uint256 n = (uint256(uint8(data[i])) << 16) | (uint256(uint8(data[i + 1])) << 8);
            out[j++] = table[(n >> 18) & 63];
            out[j++] = table[(n >> 12) & 63];
            out[j++] = table[(n >> 6) & 63];
            out[j++] = bytes1("=");
        }

        return string(out);
    }
}
