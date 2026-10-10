export async function compute(input: number): Promise<number> {
  const doubled = await input;
  return doubled;
}
export function trigger(): void {
  compute();
}
