const { spawn } = require("child_process");
const path = require("path");

const scripts = [
  "sim-create.js",
  "sim-set-testingfees.js",
];

function runScript(scriptName) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, scriptName);
    console.log(`\n=== Running ${scriptName} ===`);

    const child = spawn(process.execPath, [scriptPath], {
      cwd: __dirname,
      stdio: "inherit",
      env: {
        ...process.env,
        SIM_USER_COUNT: process.env.SIM_USER_COUNT || process.env.USER_COUNT || "10",
        USER_COUNT: process.env.USER_COUNT || process.env.SIM_USER_COUNT || "10",
      },
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start ${scriptName}: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        console.log(`=== Completed ${scriptName} ===`);
        resolve();
        return;
      }
      reject(new Error(`${scriptName} exited with code ${code}`));
    });
  });
}

async function main() {
  try {
    for (const scriptName of scripts) {
      await runScript(scriptName);
    }
    console.log("\nSimulation setup completed successfully.");
  } catch (error) {
    console.error(`\nSimulation setup failed: ${error.message}`);
    process.exit(1);
  }
}

main();
