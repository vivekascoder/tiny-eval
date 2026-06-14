export function exec(args: string[], cwd: string, throwOnError?: boolean): Promise<string>;
export function exec(args: string[], cwd: string, throwOnError: boolean, returnStdout: false): Promise<number>;
export async function exec(
  args: string[],
  cwd: string,
  throwOnError = true,
  returnStdout = true,
): Promise<string | number> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (throwOnError && exitCode !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}\n${stderr}`);
  }

  return returnStdout ? stdout : exitCode;
}
