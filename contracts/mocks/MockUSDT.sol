// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Sepolia-only USDT-like token with 6 decimals and EIP-2612 permit.
contract MockUSDT is ERC20, ERC20Permit, Ownable {
    constructor(address initialOwner)
        ERC20("Mock USDT", "mUSDT")
        ERC20Permit("Mock USDT")
        Ownable(initialOwner)
    {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
