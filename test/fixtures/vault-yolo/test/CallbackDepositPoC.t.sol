// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/Vault.sol";

/// Deposits again from the payout callback of its own withdrawal.
contract Redepositor {
    Vault public vault;
    bool redeposited;

    constructor(Vault v) payable {
        vault = v;
    }

    function run() external {
        vault.deposit{value: 1 ether}();
        vault.withdraw();
    }

    receive() external payable {
        if (!redeposited) {
            redeposited = true;
            vault.deposit{value: 1 ether}();
        }
    }
}

/// PoC: expects the violation. withdraw() clears the balance after paying out, so a deposit made
/// from the payout callback is held by the vault but credited to no one.
contract CallbackDepositPoC {
    function test_callback_deposit_is_erased() public {
        Vault vault = new Vault();
        Redepositor r = new Redepositor{value: 2 ether}(vault);
        r.run();
        require(address(vault).balance == 1 ether, "the vault does not hold the callback deposit");
        require(vault.balanceOf(address(r)) == 0, "the callback deposit was credited");
    }
}
