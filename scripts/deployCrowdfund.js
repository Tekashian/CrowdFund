// Importujemy narzędzia z Hardhat (głównie ethers.js)
const hre = require("hardhat");

async function main() {
  // Wyświetlamy informację, na jaką sieć wdrażamy
  console.log(`\nRozpoczynanie wdrażania kontraktu Crowdfund na sieć: ${hre.network.name}...`);

  // Pobieramy konto, które zapłaci za wdrożenie (z klucza w .env)
  const [deployer] = await hre.ethers.getSigners();
  // Sprawdzamy, czy konto deployera zostało poprawnie załadowane
  if (!deployer) {
    console.error("BŁĄD: Nie można uzyskać konta deployera. Sprawdź konfigurację sieci i plik .env (PRIVATE_KEY).");
    process.exit(1);
  }
  console.log("Używane konto (Deployer):", deployer.address);

  // Sprawdzamy saldo konta (czy mamy dość tBNB/ETH na paliwo?)
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Saldo konta:", hre.ethers.formatUnits(balance, "ether"), hre.network.name.includes('bsc') ? 'BNB' : 'ETH'); // Wyświetl BNB lub ETH

  if (balance === 0n) { // Sprawdzamy, czy saldo nie jest zerowe
    console.warn(`OSTRZEŻENIE: Saldo konta deployera wynosi 0. Wdrożenie może się nie udać. Potrzebujesz testowego ${hre.network.name.includes('bsc') ? 'BNB (tBNB)' : 'ETH'} z faucetu!`);
  }

  console.log("\nPobieranie skompilowanego kontraktu 'Crowdfund'...");
  // Upewnij się, że nazwa "Crowdfund" zgadza się z nazwą kontraktu w pliku .sol
  const CrowdfundFactory = await hre.ethers.getContractFactory("Crowdfund"); // Zmieniono nazwę zmiennej dla jasności
  console.log("Kontrakt pobrany.");

  // --- Argumenty dla konstruktora kontraktu Crowdfund ---
  const initialOwner = deployer.address;
  const initialStartupCommission = 200n; // 2.00% (200 oznacza 2.00%)
  const initialCharityCommission = 0n;   // 0.00% (0 oznacza 0.00%)

  console.log("\nPrzygotowywanie argumentów konstruktora:");
  console.log(`  _initialOwner: ${initialOwner}`);
  console.log(`  _initialStartupCommissionPercentage: ${initialStartupCommission.toString()}`);
  console.log(`  _initialCharityCommissionPercentage: ${initialCharityCommission.toString()}`);
  // --- Koniec argumentów konstruktora ---

  // Najważniejszy moment: Wdrażamy kontrakt!
  console.log("\nWysyłanie transakcji wdrożeniowej do sieci z argumentami...");
  const crowdfundContract = await CrowdfundFactory.deploy( // Używamy zmiennej fabryki
    initialOwner,
    initialStartupCommission,
    initialCharityCommission
  );

  // Transakcja została wysłana, ale kontrakt jeszcze nie jest "na miejscu".
  // Musimy poczekać, aż zostanie potwierdzony przez sieć.
  // W ethers v6+ .deploymentTransaction() i .getAddress() są preferowane w inny sposób,
  // ale trzymamy się Twojego wzorca, który powinien działać z Twoją wersją ethers.
  const deployTx = crowdfundContract.deploymentTransaction();
  if (!deployTx) {
      console.error("BŁĄD: Nie można uzyskać transakcji wdrożeniowej. Sprawdź, czy kontrakt został poprawnie zainicjowany.");
      process.exit(1);
  }
  console.log(`Transakcja wdrożeniowa wysłana. Hash: ${deployTx.hash}`);
  console.log("Oczekiwanie na potwierdzenie transakcji (może chwilę potrwać)...");

  // Czekamy na 1 potwierdzenie (można zwiększyć dla większej pewności)
  await deployTx.wait(1); // Czekaj na 1 potwierdzenie
  console.log("Transakcja potwierdzona!");

  // Pobieramy ostateczny adres wdrożonego kontraktu
  const contractAddress = await crowdfundContract.getAddress(); // Dla ethers v6+; lub crowdfundContract.address dla v5
  console.log(`\n✅ Kontrakt Crowdfund pomyślnie wdrożony na sieci ${hre.network.name}!`);
  console.log(`   Adres kontraktu: ${contractAddress}`);

  // --- Generowanie linku do eksploratora ---
  let explorerUrl;
  const customChains = hre.config.etherscan.customChains || [];
  const customChain = customChains.find(chain => chain.network === hre.network.name);

  if (customChain && customChain.urls.browserURL) {
    explorerUrl = `${customChain.urls.browserURL}/address/${contractAddress}`;
  } else {
    if (hre.network.name === 'bscTestnet') {
      explorerUrl = `https://testnet.bscscan.com/address/${contractAddress}`;
    } else if (hre.network.name === 'sepolia') {
      explorerUrl = `https://sepolia.etherscan.io/address/${contractAddress}`;
    } else if (hre.network.name === 'bsc') {
      explorerUrl = `https://bscscan.com/address/${contractAddress}`;
    } else if (hre.network.name === 'mainnet' || hre.network.name === 'ethereum') { // Dodano alias 'ethereum'
      explorerUrl = `https://etherscan.io/address/${contractAddress}`;
    } else {
      explorerUrl = `Eksplorator dla sieci ${hre.network.name} nie jest zdefiniowany w hardhat.config.js lub domyślnie.`;
    }
  }
  console.log(`   Możesz go sprawdzić na: ${explorerUrl}`);
  // --- Koniec generowania linku ---

  // --- Opcjonalna weryfikacja na Etherscan/BSCScan ---
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    console.log("\nOczekiwanie przed próbą weryfikacji kontraktu (daj czas Etherscan/BSCScan na zindeksowanie)...");
    await new Promise(resolve => setTimeout(resolve, 60000)); // Czekaj 60 sekund

    try {
      console.log("Rozpoczynanie weryfikacji kontraktu...");
      await hre.run("verify:verify", {
        address: contractAddress,
        constructorArguments: [
          initialOwner,
          initialStartupCommission,
          initialCharityCommission,
        ],
      });
      console.log("Weryfikacja kontraktu zakończona pomyślnie.");
    } catch (error) {
      console.error("Błąd podczas weryfikacji kontraktu:", error.message);
      if (error.message.toLowerCase().includes("already verified")) {
        console.log("Kontrakt jest już zweryfikowany.");
      } else if (error.message.toLowerCase().includes("does not have bytecode")) {
         console.log("Błąd: Kontrakt pod podanym adresem nie ma bytecode'u. Upewnij się, że adres jest poprawny i sieć działa.");
      }else {
        console.log("Możliwe, że będziesz musiał ręcznie zweryfikować kontrakt lub spróbować ponownie później.");
      }
    }
  }
  // --- Koniec weryfikacji ---


  // Zwracamy adres na wypadek, gdyby inny skrypt chciał go użyć
  return contractAddress;
}

// Standardowy sposób uruchamiania głównej funkcji i łapania błędów
main()
  .then((deployedAddress) => {
    console.log("\nSkrypt zakończył działanie pomyślnie.");
    if (deployedAddress) { // Dodatkowe info, jeśli adres został zwrócony
        console.log("Wdrożony adres kontraktu (zwrócony przez main):", deployedAddress);
    }
    process.exit(0); // Zakończ sukcesem
  })
  .catch((error) => {
    console.error("\n❌ Wystąpił błąd podczas wdrażania:");
    console.error(error);
    process.exit(1); // Zakończ z błędem
  });