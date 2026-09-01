// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ReelFortuneAnglers.sol";

/*
 * Foundry tests for ReelFortuneAnglers, WITHOUT forge-std (repo convention:
 * no libs). The cheatcode interface is declared by hand below and every
 * assertion is a plain `require` — a failing require reverts the test, which
 * is how forge marks it red.
 *
 * Run from GAME/contracts:  forge test -vv
 */

/// @dev Subset of the Foundry cheatcodes used here. Lives at the well-known
///      "hevm cheat code" address; forge intercepts calls to it.
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address, uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function expectEmit(bool, bool, bool, bool) external;
    function warp(uint256) external;
}

// ---------------------------------------------------------------------------
// Helper contracts (receivers / owners with specific behaviour)
// ---------------------------------------------------------------------------

/// @dev A well-behaved ERC-721 receiver; records the last hook arguments.
contract AcceptingReceiver {
    address public lastOperator;
    address public lastFrom;
    uint256 public lastTokenId;
    bytes public lastData;
    uint256 public calls;

    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4)
    {
        lastOperator = operator;
        lastFrom = from;
        lastTokenId = tokenId;
        lastData = data;
        calls++;
        return this.onERC721Received.selector;
    }
}

/// @dev Reverts inside the hook with a reason string (must be bubbled up).
contract RevertingReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("RevertingReceiver: nope");
    }
}

/// @dev Implements the hook but returns the wrong magic value.
contract WrongSelectorReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

/// @dev A contract with no hook, no receive, no fallback: plain ETH transfers
///      and onERC721Received calls both revert with empty data.
contract Brick {}

/// @dev A contract that can call mint() (documents that mint() has no receiver
///      hook, so contract minters are allowed) and can forward ownership calls.
contract ContractMinter {
    ReelFortuneAnglers public immutable nft;

    constructor(ReelFortuneAnglers nft_) {
        nft = nft_;
    }

    function doMint(uint256 quantity) external payable {
        nft.mint{value: msg.value}(quantity);
    }

    function doWithdraw() external {
        nft.withdraw();
    }
    // NOTE: no receive()/fallback() on purpose -> withdraw to this owner fails.
}

/// @dev Receiver whose hook re-enters the collection. Demonstrates that the
///      hook runs AFTER the ownership update (checks-effects-interactions):
///      - mode 1: tries to move the token again "from" the previous holder
///        -> must revert WrongFrom (the old holder no longer owns it);
///      - mode 2: forwards the token on to `sink` (legal: it is the owner now).
contract ReentrantReceiver {
    ReelFortuneAnglers public immutable nft;
    address public immutable sink;
    uint256 public mode;
    bool public innerReverted;

    constructor(ReelFortuneAnglers nft_, address sink_) {
        nft = nft_;
        sink = sink_;
    }

    function setMode(uint256 m) external {
        mode = m;
    }

    function onERC721Received(address, address from, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (mode == 1) {
            // Re-entrant "double spend" attempt on behalf of the old holder.
            try nft.transferFrom(from, sink, tokenId) {
                innerReverted = false;
            } catch {
                innerReverted = true;
            }
        } else if (mode == 2) {
            nft.transferFrom(address(this), sink, tokenId);
        }
        return this.onERC721Received.selector;
    }
}

/// @dev Owner contract whose receive() re-enters withdraw(). The second call
///      finds an empty balance and pays 0, so re-entrancy gains nothing.
contract ReentrantOwner {
    ReelFortuneAnglers public immutable nft;
    uint256 public depth;
    uint256 public received;
    uint256 public calls;

    constructor(ReelFortuneAnglers nft_) {
        nft = nft_;
    }

    function doWithdraw() external {
        nft.withdraw();
    }

    receive() external payable {
        calls++;
        received += msg.value;
        if (depth < 3) {
            depth++;
            nft.withdraw();
        }
    }
}

/// @dev A contract with only a fallback that returns no data: the hook call
///      "succeeds" with 0 return bytes, which must still be treated as unsafe.
contract FallbackOnlyReceiver {
    fallback() external {}
}

// ---------------------------------------------------------------------------
// Test contract
// ---------------------------------------------------------------------------

contract ReelFortuneAnglersTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Events re-declared so expectEmit can match them.
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Minted(address indexed to, uint256 indexed firstId, uint256 quantity);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Withdrawn(address indexed to, uint256 amount);

    uint256 constant MAX = 1000;
    uint256 constant PRICE = 0.005 ether;
    uint256 constant PER_WALLET = 5;
    string constant BASE = "https://reelfortune.example/nft/json/";

    ReelFortuneAnglers nft;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address operator = address(0x0BE2A7);

    // The test contract is the deployer/owner, so withdraw() pays this address.
    receive() external payable {}

    function setUp() public {
        nft = new ReelFortuneAnglers(MAX, PRICE, PER_WALLET, BASE);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // -- small helpers -------------------------------------------------------

    function _activate() internal {
        nft.setSaleActive(true);
    }

    function _mintAs(address who, uint256 qty) internal {
        vm.prank(who);
        nft.mint{value: PRICE * qty}(qty);
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    // ------------------------------------------------------------------
    // Deployment / constants
    // ------------------------------------------------------------------

    function test_DeployState() public view {
        require(_eq(nft.name(), "Reel Fortune Anglers"), "name");
        require(_eq(nft.symbol(), "RFA"), "symbol");
        require(nft.MAX_SUPPLY() == MAX, "MAX_SUPPLY");
        require(nft.mintPrice() == PRICE, "mintPrice");
        require(nft.maxPerWallet() == PER_WALLET, "maxPerWallet");
        require(nft.saleActive() == false, "sale must start inactive");
        require(nft.owner() == address(this), "owner");
        require(_eq(nft.baseURI(), BASE), "baseURI");
        require(nft.totalSupply() == 0, "totalSupply 0");
        require(nft.balanceOf(alice) == 0, "balance 0");
        require(nft.mintedBy(alice) == 0, "mintedBy 0");
        require(nft.tokensOfOwner(alice).length == 0, "tokensOfOwner empty");
    }

    function test_ConstructorRejectsZeroSupply() public {
        vm.expectRevert(ReelFortuneAnglers.InvalidSupply.selector);
        new ReelFortuneAnglers(0, PRICE, PER_WALLET, BASE);
    }

    // ------------------------------------------------------------------
    // Happy mint
    // ------------------------------------------------------------------

    function test_MintHappyPath() public {
        _activate();

        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), alice, 1);
        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), alice, 2);
        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), alice, 3);
        vm.expectEmit(true, true, true, true);
        emit Minted(alice, 1, 3);

        uint256 before = alice.balance;
        _mintAs(alice, 3);

        require(nft.totalSupply() == 3, "totalSupply");
        require(nft.balanceOf(alice) == 3, "balanceOf");
        require(nft.mintedBy(alice) == 3, "mintedBy");
        require(nft.ownerOf(1) == alice && nft.ownerOf(2) == alice && nft.ownerOf(3) == alice, "ownerOf 1..3");
        require(address(nft).balance == PRICE * 3, "contract holds ETH");
        require(alice.balance == before - PRICE * 3, "alice paid");

        uint256[] memory ids = nft.tokensOfOwner(alice);
        require(ids.length == 3 && ids[0] == 1 && ids[1] == 2 && ids[2] == 3, "tokensOfOwner");

        // Second minter continues the sequence.
        vm.expectEmit(true, true, true, true);
        emit Minted(bob, 4, 2);
        _mintAs(bob, 2);
        require(nft.totalSupply() == 5, "totalSupply after bob");
        require(nft.ownerOf(4) == bob && nft.ownerOf(5) == bob, "bob owns 4,5");
        require(address(nft).balance == PRICE * 5, "ETH accumulates");
    }

    function test_MintFromContractWithoutHookSucceeds() public {
        // mint() deliberately skips onERC721Received, so a contract minter works.
        _activate();
        ContractMinter m = new ContractMinter(nft);
        vm.deal(address(m), 1 ether);
        m.doMint{value: PRICE}(1);
        require(nft.ownerOf(1) == address(m), "contract owns token");
    }

    // ------------------------------------------------------------------
    // Every mint() revert path, in check order
    // ------------------------------------------------------------------

    function test_MintRevertsSaleNotActive() public {
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.SaleNotActive.selector);
        nft.mint{value: PRICE}(1);
    }

    function test_MintRevertsInvalidQuantityZero() public {
        _activate();
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.InvalidQuantity.selector);
        nft.mint{value: 0}(0);
    }

    function test_MintRevertsInvalidQuantityAboveWalletMax() public {
        _activate();
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.InvalidQuantity.selector);
        nft.mint{value: PRICE * (PER_WALLET + 1)}(PER_WALLET + 1);
    }

    function test_MintRevertsWalletLimitAcrossTwoTxs() public {
        _activate();
        _mintAs(alice, 3);
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.WalletLimit.selector);
        nft.mint{value: PRICE * 3}(3); // 3 + 3 > 5

        _mintAs(alice, 2); // exactly at the cap is fine: 3 + 2 == 5
        require(nft.mintedBy(alice) == PER_WALLET, "at cap");

        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.WalletLimit.selector);
        nft.mint{value: PRICE}(1); // 5 + 1 > 5

        // Another wallet is unaffected.
        _mintAs(bob, 1);
        require(nft.totalSupply() == 6, "bob still mints");
    }

    function test_MintRevertsWrongPayment() public {
        _activate();
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.WrongPayment.selector);
        nft.mint{value: PRICE - 1}(1);

        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.WrongPayment.selector);
        nft.mint{value: PRICE + 1}(1);

        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.WrongPayment.selector);
        nft.mint{value: PRICE}(2); // paid for one, asked for two

        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.WrongPayment.selector);
        nft.mint{value: 0}(1);
    }

    function test_MintRevertsSoldOutAtBoundary() public {
        // Small collection so the boundary is cheap to reach: 6 tokens, 5 per wallet.
        ReelFortuneAnglers small = new ReelFortuneAnglers(6, PRICE, 5, "");
        small.setSaleActive(true);

        vm.prank(alice);
        small.mint{value: PRICE * 5}(5);
        require(small.totalSupply() == 5, "5 minted");

        // 5 + 2 > 6 -> SoldOut (checked before WalletLimit: bob has 0 so far)
        vm.prank(bob);
        vm.expectRevert(ReelFortuneAnglers.SoldOut.selector);
        small.mint{value: PRICE * 2}(2);

        // Exactly the last one is fine.
        vm.prank(bob);
        small.mint{value: PRICE}(1);
        require(small.totalSupply() == 6, "sold out exactly");
        require(small.ownerOf(6) == bob, "last id is MAX_SUPPLY");

        // Nothing more, for anyone, including ownerMint.
        vm.prank(carol);
        vm.expectRevert(ReelFortuneAnglers.SoldOut.selector);
        small.mint{value: PRICE}(1);

        vm.expectRevert(ReelFortuneAnglers.SoldOut.selector);
        small.ownerMint(carol, 1);
    }

    function test_FullCollectionSoldOutAtRealMax() public {
        // ownerMint the whole 1000 in one go, then every path is SoldOut.
        nft.ownerMint(alice, MAX);
        require(nft.totalSupply() == MAX, "all 1000 minted");
        require(nft.balanceOf(alice) == MAX, "alice holds all");
        require(nft.ownerOf(MAX) == alice, "id 1000 exists");
        require(_eq(nft.tokenURI(MAX), "https://reelfortune.example/nft/json/1000.json"), "tokenURI 1000");

        vm.expectRevert(ReelFortuneAnglers.NonexistentToken.selector);
        nft.ownerOf(MAX + 1);

        vm.expectRevert(ReelFortuneAnglers.SoldOut.selector);
        nft.ownerMint(bob, 1);

        _activate();
        vm.prank(bob);
        vm.expectRevert(ReelFortuneAnglers.SoldOut.selector);
        nft.mint{value: PRICE}(1);
    }

    // ------------------------------------------------------------------
    // ownerMint
    // ------------------------------------------------------------------

    function test_OwnerMint() public {
        // Works while the sale is inactive, ignores the wallet cap, is free,
        // and does not count towards mintedBy.
        vm.expectEmit(true, true, true, true);
        emit Minted(bob, 1, 12);
        nft.ownerMint(bob, 12);

        require(nft.totalSupply() == 12, "12 reserved");
        require(nft.balanceOf(bob) == 12, "bob balance");
        require(nft.mintedBy(bob) == 0, "ownerMint does not count towards the cap");
        require(nft.ownerOf(1) == bob && nft.ownerOf(12) == bob, "ids 1..12");
        require(address(nft).balance == 0, "free");

        // Public mints continue after the reserve.
        _activate();
        _mintAs(bob, PER_WALLET);
        require(nft.totalSupply() == 12 + PER_WALLET, "sequence continues");
        require(nft.ownerOf(13) == bob, "id 13");
    }

    function test_OwnerMintGuards() public {
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.NotOwner.selector);
        nft.ownerMint(alice, 1);

        vm.expectRevert(ReelFortuneAnglers.ZeroAddress.selector);
        nft.ownerMint(address(0), 1);

        vm.expectRevert(ReelFortuneAnglers.InvalidQuantity.selector);
        nft.ownerMint(alice, 0);

        vm.expectRevert(ReelFortuneAnglers.SoldOut.selector);
        nft.ownerMint(alice, MAX + 1);
    }

    // ------------------------------------------------------------------
    // withdraw
    // ------------------------------------------------------------------

    function test_WithdrawToOwner() public {
        _activate();
        _mintAs(alice, 4);
        _mintAs(bob, 1);
        uint256 held = PRICE * 5;
        require(address(nft).balance == held, "held");

        uint256 before = address(this).balance;
        vm.expectEmit(true, true, true, true);
        emit Withdrawn(address(this), held);
        nft.withdraw();

        require(address(nft).balance == 0, "drained");
        require(address(this).balance == before + held, "owner received");

        // Withdrawing an empty balance is a harmless no-op.
        nft.withdraw();
        require(address(nft).balance == 0, "still 0");
    }

    function test_WithdrawOnlyOwner() public {
        _activate();
        _mintAs(alice, 1);
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.NotOwner.selector);
        nft.withdraw();
        require(address(nft).balance == PRICE, "untouched");
    }

    function test_WithdrawFailsForRejectingOwner() public {
        _activate();
        _mintAs(alice, 2);

        // Hand ownership to a contract that cannot receive ETH.
        ContractMinter brickOwner = new ContractMinter(nft);
        nft.transferOwnership(address(brickOwner));
        require(nft.owner() == address(brickOwner), "owner moved");

        vm.expectRevert(ReelFortuneAnglers.WithdrawFailed.selector);
        brickOwner.doWithdraw();
        require(address(nft).balance == PRICE * 2, "balance intact after failed withdraw");

        // The old owner is locked out now.
        vm.expectRevert(ReelFortuneAnglers.NotOwner.selector);
        nft.withdraw();
    }

    // ------------------------------------------------------------------
    // tokenURI / baseURI
    // ------------------------------------------------------------------

    function test_TokenURIFormat() public {
        _activate();
        _mintAs(alice, 2);
        require(_eq(nft.tokenURI(1), "https://reelfortune.example/nft/json/1.json"), "uri 1");
        require(_eq(nft.tokenURI(2), "https://reelfortune.example/nft/json/2.json"), "uri 2");

        nft.setBaseURI("http://localhost:8000/nft/json/");
        require(_eq(nft.baseURI(), "http://localhost:8000/nft/json/"), "baseURI updated");
        require(_eq(nft.tokenURI(2), "http://localhost:8000/nft/json/2.json"), "uri follows baseURI");
    }

    function test_TokenURIEmptyBase() public {
        ReelFortuneAnglers bare = new ReelFortuneAnglers(MAX, PRICE, PER_WALLET, "");
        bare.ownerMint(alice, 1);
        require(_eq(bare.baseURI(), ""), "empty base");
        require(_eq(bare.tokenURI(1), ""), "empty tokenURI while base is empty");
        bare.setBaseURI(BASE);
        require(_eq(bare.tokenURI(1), "https://reelfortune.example/nft/json/1.json"), "set later");
    }

    function test_TokenURINonexistent() public {
        vm.expectRevert(ReelFortuneAnglers.NonexistentToken.selector);
        nft.tokenURI(1);

        _activate();
        _mintAs(alice, 1);
        vm.expectRevert(ReelFortuneAnglers.NonexistentToken.selector);
        nft.tokenURI(2);
        vm.expectRevert(ReelFortuneAnglers.NonexistentToken.selector);
        nft.tokenURI(0);
    }

    // ------------------------------------------------------------------
    // Transfers / approvals / operators
    // ------------------------------------------------------------------

    function test_TransferFromByOwner() public {
        _activate();
        _mintAs(alice, 2);

        vm.expectEmit(true, true, true, true);
        emit Transfer(alice, bob, 1);
        vm.prank(alice);
        nft.transferFrom(alice, bob, 1);

        require(nft.ownerOf(1) == bob, "bob owns 1");
        require(nft.ownerOf(2) == alice, "alice keeps 2");
        require(nft.balanceOf(alice) == 1 && nft.balanceOf(bob) == 1, "balances");
        require(nft.totalSupply() == 2, "supply unchanged");
        require(nft.mintedBy(alice) == 2 && nft.mintedBy(bob) == 0, "mintedBy unaffected by transfers");
    }

    function test_TransferFromByApproved() public {
        _activate();
        _mintAs(alice, 1);

        vm.expectEmit(true, true, true, true);
        emit Approval(alice, carol, 1);
        vm.prank(alice);
        nft.approve(carol, 1);
        require(nft.getApproved(1) == carol, "approved");

        vm.prank(carol);
        nft.transferFrom(alice, bob, 1);
        require(nft.ownerOf(1) == bob, "moved by approved");
        require(nft.getApproved(1) == address(0), "approval cleared on transfer");

        // The old approval must not work again.
        vm.prank(carol);
        vm.expectRevert(ReelFortuneAnglers.NotAuthorized.selector);
        nft.transferFrom(bob, alice, 1);
    }

    function test_TransferFromByOperator() public {
        _activate();
        _mintAs(alice, 2);

        vm.expectEmit(true, true, true, true);
        emit ApprovalForAll(alice, operator, true);
        vm.prank(alice);
        nft.setApprovalForAll(operator, true);
        require(nft.isApprovedForAll(alice, operator), "operator set");

        // Operator may also approve on the holder's behalf.
        vm.prank(operator);
        nft.approve(carol, 2);
        require(nft.getApproved(2) == carol, "operator approved carol");

        vm.prank(operator);
        nft.transferFrom(alice, bob, 1);
        require(nft.ownerOf(1) == bob, "operator moved 1");

        vm.prank(alice);
        nft.setApprovalForAll(operator, false);
        require(!nft.isApprovedForAll(alice, operator), "operator revoked");

        vm.prank(operator);
        vm.expectRevert(ReelFortuneAnglers.NotAuthorized.selector);
        nft.transferFrom(alice, bob, 2);
    }

    function test_TransferGuards() public {
        _activate();
        _mintAs(alice, 1);

        // Stranger.
        vm.prank(bob);
        vm.expectRevert(ReelFortuneAnglers.NotAuthorized.selector);
        nft.transferFrom(alice, bob, 1);

        // Wrong `from`.
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.WrongFrom.selector);
        nft.transferFrom(bob, carol, 1);

        // To the zero address.
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.ZeroAddress.selector);
        nft.transferFrom(alice, address(0), 1);

        // Nonexistent token.
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.NonexistentToken.selector);
        nft.transferFrom(alice, bob, 2);

        // approve by a stranger / on a nonexistent token.
        vm.prank(bob);
        vm.expectRevert(ReelFortuneAnglers.NotAuthorized.selector);
        nft.approve(bob, 1);

        vm.expectRevert(ReelFortuneAnglers.NonexistentToken.selector);
        nft.approve(bob, 99);

        vm.expectRevert(ReelFortuneAnglers.NonexistentToken.selector);
        nft.getApproved(99);

        vm.expectRevert(ReelFortuneAnglers.ZeroAddress.selector);
        nft.balanceOf(address(0));

        require(nft.ownerOf(1) == alice, "state untouched by failed calls");
    }

    // ------------------------------------------------------------------
    // safeTransferFrom
    // ------------------------------------------------------------------

    function test_SafeTransferToAcceptingReceiver() public {
        _activate();
        _mintAs(alice, 2);
        AcceptingReceiver r = new AcceptingReceiver();

        vm.prank(alice);
        nft.safeTransferFrom(alice, address(r), 1);
        require(nft.ownerOf(1) == address(r), "receiver owns 1");
        require(r.calls() == 1, "hook called once");
        require(r.lastOperator() == alice && r.lastFrom() == alice && r.lastTokenId() == 1, "hook args");
        require(r.lastData().length == 0, "no data");

        // Overload with data, sent by an operator.
        vm.prank(alice);
        nft.setApprovalForAll(operator, true);
        vm.prank(operator);
        nft.safeTransferFrom(alice, address(r), 2, hex"c0ffee");
        require(nft.ownerOf(2) == address(r), "receiver owns 2");
        require(r.calls() == 2, "hook called twice");
        require(r.lastOperator() == operator && r.lastFrom() == alice && r.lastTokenId() == 2, "hook args 2");
        require(keccak256(r.lastData()) == keccak256(hex"c0ffee"), "data forwarded");

        uint256[] memory ids = nft.tokensOfOwner(address(r));
        require(ids.length == 2 && ids[0] == 1 && ids[1] == 2, "receiver tokensOfOwner");
    }

    function test_SafeTransferToRejectingReceiverBubblesReason() public {
        _activate();
        _mintAs(alice, 1);
        RevertingReceiver r = new RevertingReceiver();

        vm.prank(alice);
        vm.expectRevert(); // reason bubbled from the receiver ("RevertingReceiver: nope")
        nft.safeTransferFrom(alice, address(r), 1);
        require(nft.ownerOf(1) == alice, "rolled back");
    }

    function test_SafeTransferToWrongSelectorReceiver() public {
        _activate();
        _mintAs(alice, 1);
        WrongSelectorReceiver r = new WrongSelectorReceiver();

        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.UnsafeRecipient.selector);
        nft.safeTransferFrom(alice, address(r), 1);
        require(nft.ownerOf(1) == alice, "rolled back");
    }

    function test_SafeTransferToContractWithoutHook() public {
        _activate();
        _mintAs(alice, 1);
        Brick b = new Brick();

        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.UnsafeRecipient.selector);
        nft.safeTransferFrom(alice, address(b), 1);
        require(nft.ownerOf(1) == alice, "rolled back");

        // Plain transferFrom does not run the hook, so it goes through.
        vm.prank(alice);
        nft.transferFrom(alice, address(b), 1);
        require(nft.ownerOf(1) == address(b), "unsafe transfer allowed");
    }

    function test_SafeTransferToEOA() public {
        _activate();
        _mintAs(alice, 1);

        vm.expectEmit(true, true, true, true);
        emit Transfer(alice, bob, 1);
        vm.prank(alice);
        nft.safeTransferFrom(alice, bob, 1);
        require(nft.ownerOf(1) == bob, "EOA receives without hook");

        vm.prank(bob);
        nft.safeTransferFrom(bob, carol, 1, hex"01");
        require(nft.ownerOf(1) == carol, "EOA receives with data");
    }

    // ------------------------------------------------------------------
    // ERC-2981 royalties
    // ------------------------------------------------------------------

    function test_RoyaltyInfoDefault() public view {
        (address receiver, uint256 amount) = nft.royaltyInfo(1, 1 ether);
        require(receiver == address(this), "default receiver = deployer");
        require(amount == 0.05 ether, "default 5%");

        (, uint256 zero) = nft.royaltyInfo(999, 0);
        require(zero == 0, "0 sale -> 0 royalty");

        (, uint256 rounded) = nft.royaltyInfo(1, 19);
        require(rounded == 0, "19 wei * 5% rounds down to 0");

        (, uint256 twenty) = nft.royaltyInfo(1, 20);
        require(twenty == 1, "20 wei * 5% = 1");
    }

    function test_SetRoyalty() public {
        nft.setRoyalty(bob, 1000); // max 10 %
        (address receiver, uint256 amount) = nft.royaltyInfo(7, 2 ether);
        require(receiver == bob, "receiver updated");
        require(amount == 0.2 ether, "10%");

        nft.setRoyalty(bob, 0);
        (, uint256 none) = nft.royaltyInfo(7, 2 ether);
        require(none == 0, "0 bps");

        nft.setRoyalty(carol, 250);
        (address r2, uint256 a2) = nft.royaltyInfo(1, 10_000);
        require(r2 == carol && a2 == 250, "2.5% of 10000");

        vm.expectRevert(ReelFortuneAnglers.RoyaltyTooHigh.selector);
        nft.setRoyalty(bob, 1001);

        vm.expectRevert(ReelFortuneAnglers.ZeroAddress.selector);
        nft.setRoyalty(address(0), 100);

        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.NotOwner.selector);
        nft.setRoyalty(alice, 100);
    }

    // ------------------------------------------------------------------
    // ERC-165
    // ------------------------------------------------------------------

    function test_SupportsInterface() public view {
        require(nft.supportsInterface(0x01ffc9a7), "ERC165");
        require(nft.supportsInterface(0x80ac58cd), "ERC721");
        require(nft.supportsInterface(0x5b5e139f), "ERC721Metadata");
        require(nft.supportsInterface(0x2a55205a), "ERC2981");
        require(!nft.supportsInterface(0x780e9d63), "Enumerable not claimed");
        require(!nft.supportsInterface(0xffffffff), "0xffffffff must be false");
        require(!nft.supportsInterface(0x00000000), "zero");
    }

    // ------------------------------------------------------------------
    // Ownership + onlyOwner guards
    // ------------------------------------------------------------------

    function test_TransferOwnership() public {
        vm.expectEmit(true, true, true, true);
        emit OwnershipTransferred(address(this), bob);
        nft.transferOwnership(bob);
        require(nft.owner() == bob, "new owner");

        // Old owner is locked out of every admin function.
        vm.expectRevert(ReelFortuneAnglers.NotOwner.selector);
        nft.setSaleActive(true);
        vm.expectRevert(ReelFortuneAnglers.NotOwner.selector);
        nft.transferOwnership(address(this));

        // New owner can administer, and the royalty receiver did NOT move.
        vm.prank(bob);
        nft.setSaleActive(true);
        require(nft.saleActive(), "bob activated");
        (address receiver,) = nft.royaltyInfo(1, 1 ether);
        require(receiver == address(this), "royalty receiver unchanged by ownership transfer");

        vm.prank(bob);
        vm.expectRevert(ReelFortuneAnglers.ZeroAddress.selector);
        nft.transferOwnership(address(0));
    }

    function test_OnlyOwnerGuards() public {
        vm.startPrank(alice);

        vm.expectRevert(ReelFortuneAnglers.NotOwner.selector);
        nft.setSaleActive(true);

        vm.expectRevert(ReelFortuneAnglers.NotOwner.selector);
        nft.setMintPrice(1);

        vm.expectRevert(ReelFortuneAnglers.NotOwner.selector);
        nft.setMaxPerWallet(1);

        vm.expectRevert(ReelFortuneAnglers.NotOwner.selector);
        nft.setBaseURI("x");

        vm.expectRevert(ReelFortuneAnglers.NotOwner.selector);
        nft.setRoyalty(alice, 100);

        vm.expectRevert(ReelFortuneAnglers.NotOwner.selector);
        nft.withdraw();

        vm.expectRevert(ReelFortuneAnglers.NotOwner.selector);
        nft.ownerMint(alice, 1);

        vm.expectRevert(ReelFortuneAnglers.NotOwner.selector);
        nft.transferOwnership(alice);

        vm.stopPrank();

        // Nothing changed.
        require(!nft.saleActive() && nft.mintPrice() == PRICE && nft.maxPerWallet() == PER_WALLET, "unchanged");
        require(nft.owner() == address(this) && _eq(nft.baseURI(), BASE), "unchanged 2");
    }

    // ------------------------------------------------------------------
    // Setters that change mint behaviour
    // ------------------------------------------------------------------

    function test_SetMintPriceAndSaleToggle() public {
        _activate();
        nft.setMintPrice(0.01 ether);
        require(nft.mintPrice() == 0.01 ether, "price set");

        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.WrongPayment.selector);
        nft.mint{value: PRICE}(1); // old price no longer accepted

        vm.prank(alice);
        nft.mint{value: 0.01 ether}(1);
        require(nft.ownerOf(1) == alice, "minted at new price");

        // Free mint is allowed when price is 0.
        nft.setMintPrice(0);
        vm.prank(bob);
        nft.mint{value: 0}(1);
        require(nft.ownerOf(2) == bob, "free mint");

        nft.setSaleActive(false);
        vm.prank(carol);
        vm.expectRevert(ReelFortuneAnglers.SaleNotActive.selector);
        nft.mint{value: 0}(1);
    }

    function test_SetMaxPerWallet() public {
        _activate();
        _mintAs(alice, 5);

        nft.setMaxPerWallet(6);
        require(nft.maxPerWallet() == 6, "raised");
        _mintAs(alice, 1);
        require(nft.mintedBy(alice) == 6, "sixth allowed after raise");

        nft.setMaxPerWallet(2);
        vm.prank(bob);
        vm.expectRevert(ReelFortuneAnglers.InvalidQuantity.selector);
        nft.mint{value: PRICE * 3}(3); // above the new cap -> InvalidQuantity first

        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.WalletLimit.selector);
        nft.mint{value: PRICE}(1); // alice already has 6 > 2

        nft.setMaxPerWallet(0); // pauses public mint completely
        vm.prank(bob);
        vm.expectRevert(ReelFortuneAnglers.InvalidQuantity.selector);
        nft.mint{value: PRICE}(1);
    }

    // ------------------------------------------------------------------
    // tokensOfOwner after transfers
    // ------------------------------------------------------------------

    function test_TokensOfOwnerAfterTransfers() public {
        _activate();
        _mintAs(alice, 3); // 1,2,3
        _mintAs(bob, 2); // 4,5

        vm.prank(alice);
        nft.transferFrom(alice, bob, 2);

        uint256[] memory a = nft.tokensOfOwner(alice);
        require(a.length == 2 && a[0] == 1 && a[1] == 3, "alice [1,3]");

        uint256[] memory b = nft.tokensOfOwner(bob);
        require(b.length == 3 && b[0] == 2 && b[1] == 4 && b[2] == 5, "bob [2,4,5] ascending");

        require(nft.tokensOfOwner(carol).length == 0, "carol empty");

        vm.prank(bob);
        nft.transferFrom(bob, carol, 5);
        vm.prank(bob);
        nft.transferFrom(bob, carol, 2);

        uint256[] memory c = nft.tokensOfOwner(carol);
        require(c.length == 2 && c[0] == 2 && c[1] == 5, "carol [2,5]");
        b = nft.tokensOfOwner(bob);
        require(b.length == 1 && b[0] == 4, "bob [4]");
        require(nft.balanceOf(alice) + nft.balanceOf(bob) + nft.balanceOf(carol) == 5, "conservation");
    }

    // ------------------------------------------------------------------
    // Review: security properties demonstrated (reentrancy, overflow,
    // self-transfer, odd receivers, interface ids)
    // ------------------------------------------------------------------

    function test_ReentrantReceiverCannotMoveTokenForOldHolder() public {
        _activate();
        _mintAs(alice, 2);
        ReentrantReceiver r = new ReentrantReceiver(nft, carol);
        r.setMode(1);

        // The hook re-enters transferFrom(alice -> carol) while alice's
        // safeTransferFrom is still on the stack. Ownership is already r's,
        // so the inner call must fail (WrongFrom) and the outer one succeeds.
        vm.prank(alice);
        nft.safeTransferFrom(alice, address(r), 1);

        require(r.innerReverted(), "re-entrant move on behalf of old holder must revert");
        require(nft.ownerOf(1) == address(r), "receiver owns the token");
        require(nft.balanceOf(alice) == 1 && nft.balanceOf(carol) == 0 && nft.balanceOf(address(r)) == 1, "balances");
        require(nft.getApproved(1) == address(0), "no dangling approval");
    }

    function test_ReentrantReceiverMayForwardOwnToken() public {
        _activate();
        _mintAs(alice, 1);
        ReentrantReceiver r = new ReentrantReceiver(nft, carol);
        r.setMode(2);

        // Legal re-entrancy: r is the owner during the hook and passes it on.
        vm.prank(alice);
        nft.safeTransferFrom(alice, address(r), 1);

        require(nft.ownerOf(1) == carol, "forwarded to carol inside the hook");
        require(nft.balanceOf(alice) == 0 && nft.balanceOf(address(r)) == 0 && nft.balanceOf(carol) == 1, "balances");
        require(nft.tokensOfOwner(carol).length == 1 && nft.tokensOfOwner(address(r)).length == 0, "tokensOfOwner");
        require(nft.totalSupply() == 1, "supply unchanged");
    }

    function test_WithdrawReentrancyGainsNothing() public {
        _activate();
        _mintAs(alice, 3);
        uint256 held = PRICE * 3;

        ReentrantOwner ro = new ReentrantOwner(nft);
        nft.transferOwnership(address(ro));

        ro.doWithdraw();

        require(address(nft).balance == 0, "drained once");
        require(ro.received() == held, "owner received exactly the balance, not more");
        require(address(ro).balance == held, "actual ETH matches");
        require(ro.calls() >= 2, "receive() re-entered withdraw()");
    }

    function test_PaymentOverflowIsNotAFreeMint() public {
        _activate();
        nft.setMintPrice(type(uint256).max);

        // price * 2 overflows -> Panic(0x11) in 0.8, never a wrapped-around 0
        // that msg.value == 0 could satisfy.
        vm.prank(alice);
        vm.expectRevert();
        nft.mint{value: 0}(2);

        // Quantity 1 at that price simply cannot be paid; also reverts.
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.WrongPayment.selector);
        nft.mint{value: 1 ether}(1);

        require(nft.totalSupply() == 0, "nothing minted");
    }

    function test_SelfTransferKeepsState() public {
        _activate();
        _mintAs(alice, 1);
        vm.prank(alice);
        nft.approve(bob, 1);

        vm.prank(alice);
        nft.transferFrom(alice, alice, 1);

        require(nft.ownerOf(1) == alice, "still alice");
        require(nft.balanceOf(alice) == 1, "balance neither doubled nor zeroed");
        require(nft.getApproved(1) == address(0), "approval cleared even on self-transfer");
        uint256[] memory ids = nft.tokensOfOwner(alice);
        require(ids.length == 1 && ids[0] == 1, "tokensOfOwner [1]");
    }

    function test_ApproveZeroClearsApproval() public {
        _activate();
        _mintAs(alice, 1);
        vm.prank(alice);
        nft.approve(bob, 1);
        require(nft.getApproved(1) == bob, "set");

        vm.expectEmit(true, true, true, true);
        emit Approval(alice, address(0), 1);
        vm.prank(alice);
        nft.approve(address(0), 1);
        require(nft.getApproved(1) == address(0), "cleared");

        vm.prank(bob);
        vm.expectRevert(ReelFortuneAnglers.NotAuthorized.selector);
        nft.transferFrom(alice, bob, 1);
    }

    function test_SafeTransferToFallbackOnlyContractReverts() public {
        _activate();
        _mintAs(alice, 1);
        FallbackOnlyReceiver f = new FallbackOnlyReceiver();

        // The hook call returns 0 bytes: decoding the bytes4 fails, which
        // reverts the transfer (return-data decoding errors are not caught).
        vm.prank(alice);
        vm.expectRevert();
        nft.safeTransferFrom(alice, address(f), 1);
        require(nft.ownerOf(1) == alice, "rolled back");
    }

    function test_SafeTransferToSelfContractReverts() public {
        // The collection contract has no hook, so tokens cannot be "safely"
        // sent into it and get stuck.
        _activate();
        _mintAs(alice, 1);
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.UnsafeRecipient.selector);
        nft.safeTransferFrom(alice, address(nft), 1);
        require(nft.ownerOf(1) == alice, "rolled back");
    }

    function test_InterfaceIdsMatchXorOfSelectors() public view {
        // Recompute the ERC-165 ids from the selectors instead of trusting the
        // literals in supportsInterface().
        bytes4 erc165 = bytes4(keccak256("supportsInterface(bytes4)"));
        bytes4 erc721 = bytes4(keccak256("balanceOf(address)")) ^ bytes4(keccak256("ownerOf(uint256)"))
            ^ bytes4(keccak256("safeTransferFrom(address,address,uint256,bytes)"))
            ^ bytes4(keccak256("safeTransferFrom(address,address,uint256)"))
            ^ bytes4(keccak256("transferFrom(address,address,uint256)")) ^ bytes4(keccak256("approve(address,uint256)"))
            ^ bytes4(keccak256("setApprovalForAll(address,bool)")) ^ bytes4(keccak256("getApproved(uint256)"))
            ^ bytes4(keccak256("isApprovedForAll(address,address)"));
        bytes4 erc721Metadata =
            bytes4(keccak256("name()")) ^ bytes4(keccak256("symbol()")) ^ bytes4(keccak256("tokenURI(uint256)"));
        bytes4 erc2981 = bytes4(keccak256("royaltyInfo(uint256,uint256)"));

        require(erc165 == 0x01ffc9a7 && erc721 == 0x80ac58cd, "known ids");
        require(erc721Metadata == 0x5b5e139f && erc2981 == 0x2a55205a, "known ids 2");
        require(nft.supportsInterface(erc165), "165");
        require(nft.supportsInterface(erc721), "721");
        require(nft.supportsInterface(erc721Metadata), "721 metadata");
        require(nft.supportsInterface(erc2981), "2981");
    }

    function test_MintCheckOrderIsFixed() public {
        // Page contract: SaleNotActive -> InvalidQuantity -> SoldOut -> WalletLimit -> WrongPayment.
        // Each call below fails several checks at once; the FIRST one must win.
        ReelFortuneAnglers small = new ReelFortuneAnglers(3, PRICE, 2, "");

        // sale off + qty 0 + wrong value -> SaleNotActive
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.SaleNotActive.selector);
        small.mint{value: 1}(0);

        small.setSaleActive(true);
        // qty 5 (> cap 2, > supply 3) + wrong value -> InvalidQuantity
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.InvalidQuantity.selector);
        small.mint{value: 1}(5);

        // fill supply to 2 of 3, alice at her cap
        vm.prank(alice);
        small.mint{value: PRICE * 2}(2);
        // alice: qty 2 -> 2+2 > 3 supply AND 2+2 > 2 wallet AND wrong value -> SoldOut first
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.SoldOut.selector);
        small.mint{value: 1}(2);
        // alice: qty 1 fits supply, but 2+1 > 2 wallet AND wrong value -> WalletLimit before WrongPayment
        vm.prank(alice);
        vm.expectRevert(ReelFortuneAnglers.WalletLimit.selector);
        small.mint{value: 1}(1);
        // bob: everything fine except value -> WrongPayment
        vm.prank(bob);
        vm.expectRevert(ReelFortuneAnglers.WrongPayment.selector);
        small.mint{value: 1}(1);
    }
}
