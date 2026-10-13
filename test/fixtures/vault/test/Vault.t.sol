// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/Vault.sol";

/// The project's own test suite: legitimate behavior.
contract VaultTest {
    Vault vault;

    receive() external payable {}

    function setUp() public {
        vault = new Vault();
    }

    function test_withdraw_returns_deposit() public {
        vault.deposit{value: 1 ether}();
        uint256 before = address(this).balance;
        vault.withdraw();
        require(address(this).balance == before + 1 ether, "deposit not returned");
        require(vault.balanceOf(address(this)) == 0, "balance not cleared");
    }
}
