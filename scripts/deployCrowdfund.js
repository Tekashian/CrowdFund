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
      // Nie przerywamy, ale ostrzegamy
  }

  console.log("\nPobieranie skompilowanego kontraktu 'Crowdfund'...");
  // Upewnij się, że nazwa "Crowdfund" zgadza się z nazwą kontraktu w pliku .sol
  const Crowdfund = await hre.ethers.getContractFactory("Crowdfund");
  console.log("Kontrakt pobrany.");

  // Najważniejszy moment: Wdrażamy kontrakt!
  console.log("\nWysyłanie transakcji wdrożeniowej do sieci...");
  const crowdfundContract = await Crowdfund.deploy(); // Nasz konstruktor jest pusty, więc nie ma argumentów

  // Transakcja została wysłana, ale kontrakt jeszcze nie jest "na miejscu".
  // Musimy poczekać, aż zostanie potwierdzony przez sieć.
  const deployTx = crowdfundContract.deploymentTransaction(); // Pobierz transakcję wdrożeniową
  console.log(`Transakcja wdrożeniowa wysłana. Hash: ${deployTx.hash}`);
  console.log("Oczekiwanie na potwierdzenie transakcji (może chwilę potrwać)...");

  // Czekamy na 1 potwierdzenie (można zwiększyć dla większej pewności)
  await deployTx.wait(1); // Czekaj na 1 potwierdzenie
  console.log("Transakcja potwierdzona!");

  // Pobieramy ostateczny adres wdrożonego kontraktu
  const contractAddress = await crowdfundContract.getAddress();
  console.log(`\n✅ Kontrakt Crowdfund pomyślnie wdrożony na sieci ${hre.network.name}!`);
  console.log(`   Adres kontraktu: ${contractAddress}`);

  // --- Generowanie linku do eksploratora ---
  let explorerUrl;
  // Najpierw spróbujmy użyć konfiguracji z hardhat.config.js, jeśli istnieje dla danej sieci
  const customChains = hre.config.etherscan.customChains || [];
  const customChain = customChains.find(chain => chain.network === hre.network.name);

  if (customChain && customChain.urls.browserURL) {
      explorerUrl = `${customChain.urls.browserURL}/address/${contractAddress}`;
  } else {
      // Jeśli brak konfiguracji customChains, użyj domyślnych linków
      if (hre.network.name === 'bscTestnet') {
          explorerUrl = `https://testnet.bscscan.com/address/${contractAddress}`;
      } else if (hre.network.name === 'sepolia') {
          explorerUrl = `https://sepolia.etherscan.io/address/${contractAddress}`;
      } else if (hre.network.name === 'bsc') {
          explorerUrl = `https://bscscan.com/address/${contractAddress}`;
      } else if (hre.network.name === 'mainnet') {
          explorerUrl = `https://etherscan.io/address/${contractAddress}`;
      } else {
          // Dla innych, nieznanych sieci
          explorerUrl = `Eksplorator dla sieci ${hre.network.name} nie jest zdefiniowany w hardhat.config.js`;
      }
  }
  console.log(`   Możesz go sprawdzić na: ${explorerUrl}`);
  // --- Koniec generowania linku ---


  // Zwracamy adres na wypadek, gdyby inny skrypt chciał go użyć
  return contractAddress;
}

// Standardowy sposób uruchamiania głównej funkcji i łapania błędów
main()
  .then((deployedAddress) => {
      console.log("\nSkrypt zakończył działanie pomyślnie.");
      process.exit(0); // Zakończ sukcesem
  })
  .catch((error) => {
    console.error("\n❌ Wystąpił błąd podczas wdrażania:");
    console.error(error);
    process.exit(1); // Zakończ z błędem
  });
