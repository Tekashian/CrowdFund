// contracts/test/MockERC20.sol
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Simple ERC20 token for testing with mint functionality.
contract MockERC20 is ERC20 {
    address public owner;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_, 
        uint256 initialSupply_, 
        address _owner
    ) ERC20(name_, symbol_) {
        owner = _owner;
        _mint(_owner, initialSupply_ * (10 ** uint256(decimals_)));
    }

    function decimals() public view override returns (uint8) {
        return super.decimals();
    }

    /// @notice Mints new tokens. Only owner can mint.
    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "MockERC20: only owner can mint");
        _mint(to, amount);
    }
}
