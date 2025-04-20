// Importuj bibliotekę ethers z Hardhata
const { ethers } = require("hardhat");

/**
 * Główna funkcja asynchroniczna do wdrożenia kontraktu.
 */
async function main() {
  // Wyświetl informację o rozpoczęciu procesu
  console.log("Deploying Crowdfund contract...");

  // Pobierz fabrykę (ContractFactory) dla kontraktu "Crowdfund"
  // Upewnij się, że nazwa "Crowdfund" jest identyczna jak nazwa kontraktu w pliku .sol
  const CrowdfundFactory = await ethers.getContractFactory("Crowdfund");

  // Zainicjuj wdrożenie kontraktu. Hardhat automatycznie użyje konta
  // skonfigurowanego dla wybranej sieci (np. z PRIVATE_KEY dla Sepolia).
  // Nie przekazujemy argumentów do konstruktora, ponieważ kontrakt Crowdfund go nie posiada.
  const crowdfund = await CrowdfundFactory.deploy();

  // Poczekaj na zakończenie transakcji wdrożenia i potwierdzenie w sieci.
  // waitForDeployment() zwraca instancję wdrożonego kontraktu.
  console.log("Contract deployment transaction sent. Waiting for confirmation...");
  const deployedContract = await crowdfund.waitForDeployment();

  // Pobierz adres, pod którym kontrakt został wdrożony
  const deployedAddress = await deployedContract.getAddress();
  console.log(`Crowdfund contract successfully deployed to: ${deployedAddress}`);

  // (Opcjonalnie) Wyświetl informacje o sieci, na której wdrożono kontrakt
  try {
    const network = await ethers.provider.getNetwork();
    console.log(`Deployed on network: ${network.name} (Chain ID: ${network.chainId})`);
  } catch (netError) {
    console.warn("Could not retrieve network information:", netError.message);
  }
}

// Standardowy wzorzec Hardhata do uruchamiania funkcji main
// i obsługi błędów oraz poprawnego zakończenia procesu skryptu.
main()
  .then(() => process.exit(0)) // Zakończ sukcesem
  .catch((error) => {
    console.error("Deployment script failed:", error); // Wyświetl błąd
    process.exit(1); // Zakończ z kodem błędu
  });
