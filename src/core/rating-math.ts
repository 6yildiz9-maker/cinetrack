export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
export const clamp11 = (value: number) => Math.min(1, Math.max(-1, value));

export function bayesianRating(
  voteAverage: number | unknown,
  voteCount: number | unknown,
  { prior = 6.5, minVotes = 300 } = {}
): number {
  const average = Number(voteAverage);
  const count = Number(voteCount);
  if (!Number.isFinite(average) || average <= 0) return 5.5;
  if (!Number.isFinite(count) || count <= 0) return 5.5;
  const credibility = Math.min(1, count / minVotes);
  return credibility * average + (1 - credibility) * prior;
}

export function billingWeight(order: number | unknown): number {
  const index = Number(order);
  if (order == null || !Number.isFinite(index) || index < 0) return 0.3;
  if (index <= 2) return 1;
  if (index <= 5) return 0.7;
  if (index <= 9) return 0.45;
  return 0.3;
}
