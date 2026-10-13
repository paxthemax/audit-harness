// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Simple ether vault. Fixture for harness tests; not a real protocol.
contract Vault {
    mapping(address => uint256) public balanceOf;
    bool private locked;

    modifier nonReentrant() {
        require(!locked, "reentrant");
        locked = true;
        _;
        locked = false;
    }

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    /// @notice Pays out the caller's whole balance.
    function withdraw() external nonReentrant {
        uint256 amount = balanceOf[msg.sender];
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        balanceOf[msg.sender] = 0;
    }
}
