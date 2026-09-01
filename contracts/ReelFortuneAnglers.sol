// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * ============================================================================
 *  Reel Fortune Anglers  —  Reel Fortune 3D
 * ============================================================================
 *
 *  A 1000-piece pixel/voxel PFP collection of the Reel Fortune 3D hero,
 *  generated with HashLips and sold from the self-hosted mint page
 *  (mint.html, driven by mint/mint.js). Metadata is served by the game site:
 *  tokenURI(id) = baseURI + id + ".json"  ->  https://site/nft/json/7.json
 *
 *  This is a SEPARATE, TRANSFERABLE collectible. It is bought with ETH on
 *  the mint page and can be traded like any ERC-721. It is NEVER awarded by
 *  any in-game roll (roulette, kiosk, fish/ore drops): those stay a pure
 *  in-game economy with no cash value. Read README.md section (e) before
 *  wiring anything from this contract into game mechanics.
 *
 *  Standards: ERC-721, ERC-721 Metadata, ERC-165, ERC-2981 (royalties).
 *  No imports (repo convention, see IsleLedger.sol): the single-owner
 *  Ownable and every helper live in this file.
 *
 *  Design notes
 *  ------------
 *  - Sequential ids starting at 1 (HashLips ETH mode is 1-indexed). There is
 *    no burn, so every id in 1..totalSupply() exists and totalSupply() is
 *    also the highest minted id.
 *  - mint() makes NO external calls. It is a plain _mint without the
 *    onERC721Received hook, on purpose:
 *      1. the only payable function then has zero reentrancy surface;
 *      2. eth_estimateGas on the mint page is stable (no receiver code to
 *         run), so a revert there is always one of our five custom errors;
 *      3. the page mints to the connected account, which is an EOA in
 *         practice. A contract wallet that mints and cannot handle ERC-721
 *         keeps the token in its own address, exactly like ERC721A-style
 *         collections; it can still move it later with safeTransferFrom.
 *  - Checks-effects-interactions everywhere. The only outgoing calls are
 *    onERC721Received (after ownership is already updated) and the ETH
 *    transfer in withdraw() (to the owner only).
 *  - tokensOfOwner() scans ids 1..totalSupply(). It is a view for eth_call
 *    from the mint page; with MAX_SUPPLY = 1000 that is trivially cheap
 *    off-chain and it keeps transfers free of enumeration bookkeeping.
 *    ERC-721 Enumerable (0x780e9d63) is therefore NOT claimed.
 *  - mint() order of checks is part of the public contract with the mint
 *    page (it decodes the revert data into a human message):
 *      SaleNotActive -> InvalidQuantity -> SoldOut -> WalletLimit -> WrongPayment
 */

/// @dev ERC-721 token receiver hook (EIP-721). Declared here instead of
///      imported so the file stays dependency-free.
interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

contract ReelFortuneAnglers {
    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    // mint() — the five the mint page decodes, in the order they are checked.
    error SaleNotActive();
    error InvalidQuantity();
    error SoldOut();
    error WalletLimit();
    error WrongPayment();

    // ERC-721
    error NonexistentToken();
    error ZeroAddress();
    error NotAuthorized();
    error WrongFrom();
    error UnsafeRecipient();

    // admin
    error NotOwner();
    error InvalidSupply();
    error RoyaltyTooHigh();
    error WithdrawFailed();

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    /// @notice One per mint()/ownerMint() call; the ids are firstId..firstId+quantity-1.
    event Minted(address indexed to, uint256 indexed firstId, uint256 quantity);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Withdrawn(address indexed to, uint256 amount);
    event SaleActiveSet(bool active);
    event MintPriceSet(uint256 priceWei);
    event MaxPerWalletSet(uint256 limit);
    event BaseURISet(string baseURI);
    event RoyaltySet(address indexed receiver, uint96 bps);

    // ------------------------------------------------------------------
    // Metadata / constants
    // ------------------------------------------------------------------

    string public constant name = "Reel Fortune Anglers";
    string public constant symbol = "RFA";

    /// @notice Hard cap on the number of tokens that can ever exist.
    uint256 public immutable MAX_SUPPLY;

    uint96 private constant _MAX_ROYALTY_BPS = 1000; // 10 %
    uint96 private constant _DEFAULT_ROYALTY_BPS = 500; // 5 %
    uint256 private constant _BPS_DENOMINATOR = 10_000;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    /// @notice Single admin: sale switches, price, URI, royalty, withdraw, ownerMint.
    address public owner;

    /// @notice Price per token in wei for the public mint().
    uint256 public mintPrice;

    /// @notice Max tokens one wallet may buy through mint() in total (ownerMint does not count).
    uint256 public maxPerWallet;

    /// @notice Public mint switch. Deployed off; enable with setSaleActive(true).
    bool public saleActive;

    /// @notice Metadata prefix; tokenURI = baseURI + id + ".json". Empty => tokenURI returns "".
    string public baseURI;

    /// @notice Tokens bought through mint() per wallet (used for the per-wallet cap).
    mapping(address => uint256) public mintedBy;

    uint256 private _minted; // == totalSupply(), no burn
    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    address private _royaltyReceiver;
    uint96 private _royaltyBps;

    // ------------------------------------------------------------------
    // Constructor / Ownable
    // ------------------------------------------------------------------

    /// @param maxSupply_    collection size (1000 for Reel Fortune Anglers)
    /// @param mintPrice_    price per token in wei
    /// @param maxPerWallet_ per-wallet cap for the public mint
    /// @param baseURI_      e.g. "https://site/nft/json/" (trailing slash!) — may be "" and set later
    constructor(uint256 maxSupply_, uint256 mintPrice_, uint256 maxPerWallet_, string memory baseURI_) {
        if (maxSupply_ == 0) revert InvalidSupply();
        MAX_SUPPLY = maxSupply_;
        mintPrice = mintPrice_;
        maxPerWallet = maxPerWallet_;
        baseURI = baseURI_;

        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);

        _royaltyReceiver = msg.sender;
        _royaltyBps = _DEFAULT_ROYALTY_BPS;
        emit RoyaltySet(msg.sender, _DEFAULT_ROYALTY_BPS);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Hand the admin role to another address (also the default royalty receiver stays as is).
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ------------------------------------------------------------------
    // Mint
    // ------------------------------------------------------------------

    /**
     * @notice Public mint. Pay exactly mintPrice * quantity.
     * @dev    No external calls (see the header for why). Check order is fixed:
     *         SaleNotActive, InvalidQuantity, SoldOut, WalletLimit, WrongPayment.
     */
    function mint(uint256 quantity) external payable {
        if (!saleActive) revert SaleNotActive();
        uint256 limit = maxPerWallet;
        if (quantity == 0 || quantity > limit) revert InvalidQuantity();
        uint256 minted = _minted;
        if (minted + quantity > MAX_SUPPLY) revert SoldOut();
        uint256 already = mintedBy[msg.sender];
        if (already + quantity > limit) revert WalletLimit();
        if (msg.value != mintPrice * quantity) revert WrongPayment();

        mintedBy[msg.sender] = already + quantity;
        _mintBatch(msg.sender, minted, quantity);
    }

    /**
     * @notice Reserve mint for the team / giveaways. Free, ignores saleActive and the
     *         per-wallet cap, does not count towards mintedBy. Only the supply cap applies.
     */
    function ownerMint(address to, uint256 quantity) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (quantity == 0) revert InvalidQuantity();
        uint256 minted = _minted;
        if (minted + quantity > MAX_SUPPLY) revert SoldOut();
        _mintBatch(to, minted, quantity);
    }

    /// @dev Assigns ids minted+1 .. minted+quantity to `to`. Callers have already
    ///      checked the supply cap and that `to` is non-zero. No receiver hook.
    function _mintBatch(address to, uint256 minted, uint256 quantity) private {
        uint256 firstId = minted + 1;
        uint256 lastId = minted + quantity;
        _minted = lastId;
        unchecked {
            // bounded by MAX_SUPPLY, cannot overflow
            _balanceOf[to] += quantity;
        }
        for (uint256 id = firstId; id <= lastId; ++id) {
            _ownerOf[id] = to;
            emit Transfer(address(0), to, id);
        }
        emit Minted(to, firstId, quantity);
    }

    // ------------------------------------------------------------------
    // Admin setters
    // ------------------------------------------------------------------

    function setSaleActive(bool active) external onlyOwner {
        saleActive = active;
        emit SaleActiveSet(active);
    }

    function setMintPrice(uint256 priceWei) external onlyOwner {
        mintPrice = priceWei;
        emit MintPriceSet(priceWei);
    }

    /// @dev Setting 0 effectively pauses the public mint (every quantity is invalid).
    function setMaxPerWallet(uint256 limit) external onlyOwner {
        maxPerWallet = limit;
        emit MaxPerWalletSet(limit);
    }

    /// @param newBaseURI include the trailing slash, e.g. "https://site/nft/json/".
    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        baseURI = newBaseURI;
        emit BaseURISet(newBaseURI);
    }

    /// @notice ERC-2981 royalty for the whole collection. bps out of 10_000, max 1000 (10 %).
    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        if (receiver == address(0)) revert ZeroAddress();
        if (bps > _MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        _royaltyReceiver = receiver;
        _royaltyBps = bps;
        emit RoyaltySet(receiver, bps);
    }

    /// @notice Send the whole ETH balance to the owner.
    /// @dev    Owner-only and pays the owner only, so a reentrant call gains nothing;
    ///         the event is logged before the call and rolled back with the revert.
    function withdraw() external onlyOwner {
        address to = owner;
        uint256 amount = address(this).balance;
        emit Withdrawn(to, amount);
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    // ------------------------------------------------------------------
    // ERC-721 (view)
    // ------------------------------------------------------------------

    /// @notice Number of tokens minted so far (no burn, so also the highest id).
    function totalSupply() external view returns (uint256) {
        return _minted;
    }

    function balanceOf(address account) external view returns (uint256) {
        if (account == address(0)) revert ZeroAddress();
        return _balanceOf[account];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address holder = _ownerOf[tokenId];
        if (holder == address(0)) revert NonexistentToken();
        return holder;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId); // revert if the token does not exist
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address account, address operator) public view returns (bool) {
        return _operatorApprovals[account][operator];
    }

    /// @notice baseURI + id + ".json"; "" while baseURI is empty. Reverts for unminted ids.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId); // revert if the token does not exist
        string memory base = baseURI;
        if (bytes(base).length == 0) return "";
        return string(abi.encodePacked(base, _toString(tokenId), ".json"));
    }

    /// @notice Every token id held by `account`, ascending. Meant for eth_call (off-chain);
    ///         it scans 1..totalSupply(), which is fine for a 1000-piece collection.
    function tokensOfOwner(address account) external view returns (uint256[] memory ids) {
        uint256 n = _balanceOf[account];
        ids = new uint256[](n);
        if (n == 0) return ids;
        uint256 found;
        uint256 last = _minted;
        for (uint256 id = 1; id <= last; ++id) {
            if (_ownerOf[id] == account) {
                ids[found++] = id;
                if (found == n) break;
            }
        }
    }

    // ------------------------------------------------------------------
    // ERC-2981 / ERC-165
    // ------------------------------------------------------------------

    /// @notice Collection-wide royalty: receiver + salePrice * bps / 10_000.
    function royaltyInfo(uint256, uint256 salePrice) external view returns (address receiver, uint256 royaltyAmount) {
        receiver = _royaltyReceiver;
        royaltyAmount = (salePrice * _royaltyBps) / _BPS_DENOMINATOR;
    }

    /**
     * @dev 0x01ffc9a7 = IERC165, 0x80ac58cd = IERC721, 0x5b5e139f = IERC721Metadata,
     *      0x2a55205a = IERC2981. Enumerable is not claimed; use tokensOfOwner().
     */
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f
            || interfaceId == 0x2a55205a;
    }

    // ------------------------------------------------------------------
    // ERC-721 approvals
    // ------------------------------------------------------------------

    function approve(address to, uint256 tokenId) external {
        address holder = ownerOf(tokenId);
        if (msg.sender != holder && !isApprovedForAll(holder, msg.sender)) revert NotAuthorized();
        _tokenApprovals[tokenId] = to;
        emit Approval(holder, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    // ------------------------------------------------------------------
    // ERC-721 transfers
    // ------------------------------------------------------------------

    function transferFrom(address from, address to, uint256 tokenId) public {
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        _transfer(from, to, tokenId);
        _checkOnERC721Received(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external {
        _transfer(from, to, tokenId);
        _checkOnERC721Received(from, to, tokenId, data);
    }

    /// @dev Checks, then effects. No external calls here.
    function _transfer(address from, address to, uint256 tokenId) private {
        address holder = ownerOf(tokenId); // NonexistentToken
        if (holder != from) revert WrongFrom();
        if (to == address(0)) revert ZeroAddress();
        if (
            msg.sender != holder && _tokenApprovals[tokenId] != msg.sender
                && !_operatorApprovals[holder][msg.sender]
        ) revert NotAuthorized();

        delete _tokenApprovals[tokenId];
        unchecked {
            // from holds the token, so its balance is >= 1; to is bounded by MAX_SUPPLY
            _balanceOf[from] -= 1;
            _balanceOf[to] += 1;
        }
        _ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    /// @dev Interaction step of safeTransferFrom, run after the state change.
    ///      Bubbles the receiver's own revert reason when it has one.
    function _checkOnERC721Received(address from, address to, uint256 tokenId, bytes memory data) private {
        if (to.code.length == 0) return; // EOA
        try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 retval) {
            if (retval != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
        } catch (bytes memory reason) {
            if (reason.length == 0) revert UnsafeRecipient();
            assembly {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    // ------------------------------------------------------------------
    // Helper: uint256 -> string (same as IsleLedger.sol)
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
