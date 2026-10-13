// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/Vault.sol";

/// Handler: the actors' meaningful actions, with a ghost ledger kept independently of the vault.
contract Handler {
    Vault public vault;
    uint256 public ghostDeposits;

    constructor(Vault v) payable {
        vault = v;
    }

    receive() external payable {}

    function deposit(uint96 amount) external {
        uint256 a = uint256(amount) % 1 ether + 1;
        if (address(this).balance < a) return;
        vault.deposit{value: a}();
        ghostDeposits += a;
    }

    function withdraw() external {
        uint256 owed = vault.balanceOf(address(this));
        vault.withdraw();
        ghostDeposits -= owed;
    }
}

/// Property: the vault always holds exactly what depositors are owed (conservation).
contract VaultInvariant {
    Vault vault;
    Handler handler;

    function setUp() public {
        vault = new Vault();
        handler = new Handler{value: 100 ether}(vault);
    }

    function targetContracts() public view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(handler);
    }

    function invariant_vault_holds_what_it_owes() public view {
        require(address(vault).balance == vault.balanceOf(address(handler)), "vault balance != owed");
        require(handler.ghostDeposits() == vault.balanceOf(address(handler)), "ghost ledger mismatch");
    }
}
