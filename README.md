# Decentralized Crowdfunding Platform - Solidity Smart Contract

## Overview

This repository contains the core Solidity smart contract (`Crowdfund.sol`) for a decentralized crowdfunding platform built on the Ethereum blockchain. It enables users to create funding campaigns, accept donations in Ether, and allow creators to withdraw funds upon reaching the campaign goal. The contract incorporates security best practices, including protection against reentrancy attacks.

This project utilizes the Hardhat development environment for compilation, testing, and deployment workflows.

## Features

* **Campaign Creation:** Users can launch new crowdfunding campaigns with a specific funding target, duration, and descriptive data (via CID).
* **Donations:** Any user can donate Ether to active campaigns.
* **Target Achievement:** Campaigns automatically transition to a 'Completed' state upon reaching their funding goal.
* **Fund Withdrawal:** Campaign creators can securely withdraw the collected funds once the campaign is completed. Funds are sent directly to the creator's address.
* **Campaign Cancellation:** Creators can cancel their campaigns before the deadline if needed (Note: refund logic is not implemented within this contract).
* **Reentrancy Protection:** Utilizes OpenZeppelin's `ReentrancyGuard` to mitigate reentrancy vulnerabilities.
* **Event Emission:** Emits events for key actions (creation, donation, withdrawal, cancellation) for off-chain monitoring and UI updates.
* **NatSpec Documentation:** Comprehensive inline documentation following the Ethereum Natural Language Specification for clarity and developer tooling integration.

## Contract Details

* **Primary Contract:** `Crowdfund.sol`
* **Solidity Version:** `^0.8.20`
* **Dependencies:**
    * `@openzeppelin/contracts/utils/ReentrancyGuard.sol`

## Getting Started

### Prerequisites

* Node.js (v18 or later recommended)
* npm or yarn
* Git

### Installation

1.  **Clone the repository:**
    ```bash
    git clone <your-repository-url>
    cd <repository-directory>
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    # or
    # yarn install
    ```

## Usage

### Compilation

Compile the smart contracts using Hardhat:

```bash
npx hardhat compile
This will generate ABI and bytecode artifacts in the artifacts/ directory.TestingRun the comprehensive test suite:npx hardhat test
Run code coverage analysis:npx hardhat coverage
Generate a gas usage report (ensure hardhat-gas-reporter is configured in hardhat.config.js):npx hardhat test
DeploymentConfigure Network: Ensure your hardhat.config.js includes configuration for the target network (e.g., Sepolia testnet), including an RPC URL and a deployer account's private key (use environment variables for security).Run Deployment Script: Execute the deployment script (assuming it's named deployCrowdfund.js in the scripts/ directory):npx hardhat run scripts/deployCrowdfund.js --network sepolia
Replace sepolia with the desired network name configured in your Hardhat config. The script will output the deployed contract address.Key FunctionscreateCampaign(uint256 _targetAmount, string memory _dataCID, uint256 _endTime): Creates a new campaign.donate(uint256 _campaignId): Allows donation to a specific campaign ID. Send Ether with the call.withdrawFunds(uint256 _campaignId): Allows the creator to withdraw funds from a completed campaign.cancelCampaign(uint256 _campaignId): Allows the creator to cancel an active campaign before its deadline.getCampaignCreator(uint256 _campaignId): Returns the address of the campaign's creator.campaigns(uint256 _campaignId): Public mapping to view campaign details by ID.nextCampaignId(): Public variable showing the next available campaign ID.EventsCampaignCreated: Emitted upon successful campaign creation.DonationReceived: Emitted when a donation is made.FundsWithdrawn: Emitted when the creator withdraws funds.CampaignCancelled: Emitted when a campaign is cancelled.Security ConsiderationsReentrancy Guard: The contract uses OpenZeppelin's ReentrancyGuard.Checks-Effects-Interactions Pattern: Applied where appropriate, notably in withdrawFunds.Access Control: Critical functions (withdrawFunds, cancelCampaign) are restricted to the campaign creator.NatSpec Documentation: Enhances code understanding and review.Audits: For production deployment, a professional security audit is strongly recommended. This codebase has not yet undergone a formal external audit.Testing: A comprehensive test suite is provided, including coverage and gas analysis. Static analysis (e.g., Slither) is also recommended.ContributingContributions are welcome! Please follow standard Git workflow practices (fork, branch, pull request). Ensure tests pass and adhere to the existing coding style. For major changes, please open an issue first to discuss.LicenseThis project is licensed under the MIT License. See