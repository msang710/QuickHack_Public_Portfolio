const keepAlive = setInterval(() => undefined, 60_000);

function stop() {
  clearInterval(keepAlive);
  process.exit(0);
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
