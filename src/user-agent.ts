const platformToken =
  process.platform === "win32"
    ? "Windows NT 10.0; Win64; x64"
    : process.platform === "linux"
      ? "X11; Linux x86_64"
      : "Macintosh; Intel Mac OS X 10_15_7";

export const BROWSER_USER_AGENT = `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`;

export const SHORT_BROWSER_USER_AGENT = `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36`;
