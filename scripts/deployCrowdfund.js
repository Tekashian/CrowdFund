// Importujemy narzędzia z Hardhat (głównie ethers.js)
const hre = require("hardhat");

async function main() {
    // Wyświetlamy informację, na jaką sieć wdrażamy
    console.log(`\nRozpoczynanie wdrażania kontraktu Crowdfund na sieć: ${hre.network.name}...`);

    // Pobieramy konto, które zapłaci za wdrożenie (z klucza w .env)
    const [deployer] = await hre.ethers.getSigners();
    if (!deployer) {
        console.error("BŁĄD: Nie można uzyskać konta deployera. Sprawdź konfigurację sieci i plik .env (PRIVATE_KEY).");
        process.exit(1);
    }
    console.log("Używane konto (Deployer):", deployer.address);

    // Sprawdzamy saldo konta
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log("Saldo konta:", hre.ethers.formatUnits(balance, "ether"), hre.network.name.includes('bsc') ? 'BNB' : 'ETH');

    if (balance === 0n) {
        console.warn(`OSTRZEŻENIE: Saldo konta deployera wynosi 0. Wdrożenie może się nie udać. Potrzebujesz testowego ${hre.network.name.includes('bsc') ? 'BNB (tBNB)' : 'ETH'} z faucetu!`);
    }

    console.log("\nPobieranie skompilowanego kontraktu 'Crowdfund'...");
    const CrowdfundFactory = await hre.ethers.getContractFactory("Crowdfund");
    console.log("Kontrakt pobrany.");

    // --- Argumenty dla konstruktora kontraktu Crowdfund (v5.5.x) ---
    const initialOwner = deployer.address; // Właściciel kontraktu
    const initialCommissionWallet = deployer.address; // Domyślnie portfel deployera, można zmienić na dedykowany adres
    
    // Prowizje od donacji (w punktach bazowych, 100 = 1.00%)
    const initialStartupDonationCommPerc = 200n;  // 2.00%
    const initialCharityDonationCommPerc = 50n;   // 0.50%
    
    // Prowizja od zwrotu (np. 1000 = 10.00%)
    const initialRefundCommPerc = 1000n;          // 10.00%
    
    // Prowizje od sukcesu kampanii (np. 0 = 0.00% na start)
    const initialStartupSuccessCommPerc = 0n;     // 0.00%
    const initialCharitySuccessCommPerc = 0n;     // 0.00%

    console.log("\nPrzygotowywanie argumentów konstruktora:");
    console.log(`  _initialOwner: ${initialOwner}`);
    console.log(`  _initialCommissionWallet: ${initialCommissionWallet}`);
    console.log(`  _initialStartupDonationCommPerc: ${initialStartupDonationCommPerc.toString()}`);
    console.log(`  _initialCharityDonationCommPerc: ${initialCharityDonationCommPerc.toString()}`);
    console.log(`  _initialRefundCommPerc: ${initialRefundCommPerc.toString()}`);
    console.log(`  _initialStartupSuccessCommPerc: ${initialStartupSuccessCommPerc.toString()}`);
    console.log(`  _initialCharitySuccessCommPerc: ${initialCharitySuccessCommPerc.toString()}`);
    // --- Koniec argumentów konstruktora ---

    console.log("\nWysyłanie transakcji wdrożeniowej do sieci z argumentami...");
    const crowdfundContract = await CrowdfundFactory.deploy(
        initialOwner,
        initialCommissionWallet,
        initialStartupDonationCommPerc,
        initialCharityDonationCommPerc,
        initialRefundCommPerc,
        initialStartupSuccessCommPerc,
        initialCharitySuccessCommPerc
    );

    const deployTx = crowdfundContract.deploymentTransaction();
    if (!deployTx) {
        console.error("BŁĄD: Nie można uzyskać transakcji wdrożeniowej.");
        process.exit(1);
    }
    console.log(`Transakcja wdrożeniowa wysłana. Hash: ${deployTx.hash}`);
    console.log("Oczekiwanie na potwierdzenie transakcji (może chwilę potrwać)...");
    
    // Czekamy na określoną liczbę potwierdzeń dla większej pewności
    const confirmations = hre.network.name === "hardhat" || hre.network.name === "localhost" ? 1 : 2; // Mniej dla sieci lokalnych
    await deployTx.wait(confirmations);
    console.log(`Transakcja potwierdzona (${confirmations} blok(i/ów)).`);

    const contractAddress = await crowdfundContract.getAddress();
    console.log(`\n✅ Kontrakt Crowdfund pomyślnie wdrożony na sieci ${hre.network.name}!`);
    console.log(`   Adres kontraktu: ${contractAddress}`);

    // --- Generowanie linku do eksploratora ---
    let explorerUrl;
    const customChains = hre.config.etherscan.customChains || []; // Upewnij się, że masz etherscan skonfigurowany w hardhat.config.js
    const customChain = customChains.find(chain => chain.network === hre.network.name);

    if (customChain && customChain.urls.browserURL) {
        explorerUrl = `${customChain.urls.browserURL.replace(/\/$/, "")}/address/${contractAddress}`;
    } else {
        // Domyślne, popularne eksploratory
        const explorerMap = {
            "bscTestnet": "https://testnet.bscscan.com",
            "sepolia": "https://sepolia.etherscan.io",
            "bsc": "https://bscscan.com",
            "mainnet": "https://etherscan.io",
            "ethereum": "https://etherscan.io", // Alias dla mainnet
            "polygon": "https://polygonscan.com",
            "polygonMumbai": "https://mumbai.polygonscan.com",
            // Dodaj inne sieci według potrzeb
        };
        if (explorerMap[hre.network.name]) {
            explorerUrl = `${explorerMap[hre.network.name]}/address/${contractAddress}`;
        } else {
            explorerUrl = `Eksplorator dla sieci '${hre.network.name}' nie jest zdefiniowany. Dodaj go w hardhat.config.js (etherscan.customChains) lub w skrypcie.`;
        }
    }
    console.log(`   Możesz go sprawdzić na: ${explorerUrl}`);
    // --- Koniec generowania linku ---

    // --- Opcjonalna weryfikacja na Etherscan/BSCScan ---
    // Upewnij się, że masz skonfigurowany plugin hardhat-etherscan i odpowiedni API_KEY w .env
    if (hre.network.name !== "hardhat" && hre.network.name !== "localhost" && hre.config.etherscan.apiKey && hre.config.etherscan.apiKey !== "YOUR_ETHERSCAN_API_KEY") {
        console.log("\nOczekiwanie przed próbą weryfikacji kontraktu (60 sekund, aby Etherscan/itp. zindeksował transakcję)...");
        await new Promise(resolve => setTimeout(resolve, 60000)); // Czekaj 60 sekund

        try {
            console.log("Rozpoczynanie weryfikacji kontraktu na eksploratorze bloków...");
            await hre.run("verify:verify", {
                address: contractAddress,
                constructorArguments: [
                    initialOwner,
                    initialCommissionWallet,
                    initialStartupDonationCommPerc,
                    initialCharityDonationCommPerc,
                    initialRefundCommPerc,
                    initialStartupSuccessCommPerc,
                    initialCharitySuccessCommPerc
                ],
            });
            console.log("Weryfikacja kontraktu zakończona pomyślnie (lub już zweryfikowany).");
        } catch (error) {
            console.error("Błąd podczas weryfikacji kontraktu:", error.message);
            if (error.message.toLowerCase().includes("already verified")) {
                console.log("Kontrakt jest już zweryfikowany na eksploratorze.");
            } else if (error.message.toLowerCase().includes("does not have bytecode") || error.message.toLowerCase().includes("unable to  locate contract code")) {
                console.log("Błąd: Kontrakt pod podanym adresem nie ma bytecode'u lub nie został jeszcze zindeksowany. Upewnij się, że adres jest poprawny, sieć działa, i spróbuj ponownie później.");
            } else {
                console.log("Możliwe, że będziesz musiał ręcznie zweryfikować kontrakt lub spróbować ponownie później.");
            }
        }
    } else if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
        console.log("\nPominięto automatyczną weryfikację: brak klucza API etherscan w konfiguracji lub sieć to hardhat/localhost.");
    }
    // --- Koniec weryfikacji ---

    return contractAddress;
}

main()
    .then((deployedAddress) => {
        console.log("\nSkrypt wdrożeniowy zakończył działanie.");
        if (deployedAddress) {
            console.log("Adres wdrożonego kontraktu Crowdfund:", deployedAddress);
        }
        process.exit(0);
    })
    .catch((error) => {
        console.error("\n❌ Wystąpił krytyczny błąd podczas wykonywania skryptu wdrożeniowego:");
        console.error(error);
        process.exit(1);
    });