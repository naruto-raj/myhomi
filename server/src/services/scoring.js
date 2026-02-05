export function monthlyPayment(loanAmount, annualRatePct, termYears) {
  if (loanAmount <= 0) return 0;
  const monthlyRate = annualRatePct / 100 / 12;
  const n = termYears * 12;
  if (monthlyRate === 0) return loanAmount / n;
  const factor = Math.pow(1 + monthlyRate, n);
  return (loanAmount * monthlyRate * factor) / (factor - 1);
}

export function scoreRegions(regions, inputs) {
  return regions.map((region) => {
    const loan = Math.max(region.avgPrice - inputs.deposit, 0);
    const payment = monthlyPayment(loan, inputs.mortgageRate, inputs.termYears);
    const feasible =
      payment <= inputs.maxMonthlyBudget &&
      region.commuteMins <= inputs.maxCommuteMins &&
      region.crimeIndex <= inputs.maxCrimeIndex;

    return {
      region,
      feasible,
      payment,
    };
  });
}
