export const randomUUID = () => crypto.randomUUID();
export function changedBlockIndices(source: string[], current: string[]): Set<number> {
  const dp = Array.from({ length: source.length + 1 }, () => Array(current.length + 1).fill(0));
  for (let i = source.length - 1; i >= 0; i--) for (let j = current.length - 1; j >= 0; j--) dp[i][j] = source[i] === current[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const matches = new Set<number>();
  let i = 0, j = 0;
  while (i < source.length && j < current.length) {
    if (source[i] === current[j]) { matches.add(j); i++; j++; }
    else if (dp[i + 1][j] > dp[i][j + 1]) i++;
    else j++;
  }
  return new Set(current.map((_, index) => index).filter(index => !matches.has(index)));
}
