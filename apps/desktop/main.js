import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, shell, nativeImage } from "electron";
import { spawn, execSync } from "child_process";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

// 判断是否是打包后的应用
const isPackaged = app.isPackaged;

// 获取资源路径
function getResourcePath(...paths) {
  if (isPackaged) {
    return join(process.resourcesPath, ...paths);
  }
  return join(import.meta.dirname, "..", "..", ...paths);
}

// 获取 openclaw CLI 路径
function getOpenClawPath() {
  if (isPackaged) {
    // 打包后使用 Electron 作为 Node.js 运行（需要设置 ELECTRON_RUN_AS_NODE=1）
    const nodePath = process.execPath;
    const nodeModulesPath = join(process.resourcesPath, "node_modules");
    // bundle 放在 node_modules 目录内，这样 ESM 模块解析能正常工作
    const bundlePath = join(nodeModulesPath, "openclaw-bundle.mjs");
    if (existsSync(bundlePath)) {
      return { 
        node: nodePath, 
        entry: bundlePath, 
        cwd: nodeModulesPath,  // 设置工作目录为 node_modules
        runAsNode: true  // 标记需要设置 ELECTRON_RUN_AS_NODE
      };
    }
    // 回退到旧的 entry.js（兼容性）
    const entryPath = join(process.resourcesPath, "openclaw-dist", "entry.js");
    if (existsSync(entryPath)) {
      return { node: nodePath, entry: entryPath, runAsNode: true };
    }
  }
  
  // 开发模式：使用项目根目录的 dist/entry.js
  const projectRoot = join(import.meta.dirname, "..", "..");
  const devEntryPath = join(projectRoot, "dist", "entry.js");
  
  if (existsSync(devEntryPath)) {
    return { useNode: true, entry: devEntryPath, cwd: projectRoot };
  }
  
  // 回退：尝试使用 pnpm openclaw
  return { usePnpm: true, cwd: projectRoot };
}

// 获取应用图标路径 (优先使用 PNG，其次 ICO)
function getIconPath() {
  const rendererDir = join(import.meta.dirname, "renderer");
  // 尝试多种图标格式
  const iconFormats = ["logo.ico", "logo.png"];
  for (const iconFile of iconFormats) {
    const iconPath = join(rendererDir, iconFile);
    try {
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) {
        console.log("使用图标:", iconPath);
        return iconPath;
      }
    } catch (err) {
      // 继续尝试下一个格式
    }
  }
  return null;
}

let mainWindow = null;
let cliProcess = null;
let gatewayProcess = null;
let gatewayWaitInterval = null;

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  // 获取应用图标路径
  const iconPath = getIconPath();

  mainWindow = new BrowserWindow({
    title: "OPENCLAW-SecurityAudit-CN",
    width: width,
    height: height,
    show: false, // 先不显示，等加载完成后再显示
    autoHideMenuBar: true, // 隐藏菜单栏
    frame: true, // 保留窗口框架（标题栏）
    icon: iconPath, // 设置窗口图标（同时用于任务栏）
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(import.meta.dirname, "preload.js"),
    },
  });

  // 移除菜单栏
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setMenu(null);

  // 最大化窗口（全屏效果）
  mainWindow.maximize();

  // 先显示 Loading 页面
  mainWindow.loadFile("renderer/loading.html");
  
  // 确保窗口在 2 秒内显示（防止卡住）
  const showWindowTimeout = setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.log("强制显示窗口（超时保护）");
      mainWindow.show();
    }
  }, 2000);

  // 启动 Gateway 并加载 Control UI
  async function startGatewayAndLoadUI() {
    let controlUiUrl = "http://127.0.0.1:18789/";
    let token = null;
    
    // 读取配置获取 token
    try {
      const content = await readFile(CONFIG_PATH, "utf-8");
      const config = JSON.parse(content);
      token = config.gateway?.auth?.token || process.env.OPENCLAW_GATEWAY_TOKEN;
      if (token) {
        controlUiUrl = `http://127.0.0.1:18789/?token=${encodeURIComponent(token)}`;
      }
    } catch (err) {
      console.warn("读取配置失败:", err.message);
    }
    
    // 检查 Gateway 是否在运行（可配置超时）
    const checkGateway = async (timeoutMs = 3000) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch("http://127.0.0.1:18789/api/health", { 
          signal: controller.signal,
          headers: token ? { "Authorization": `Bearer ${token}` } : {}
        });
        clearTimeout(timeout);
        return res.ok;
      } catch {
        return false;
      }
    };

    // 发送状态更新到渲染进程
    const updateStatus = (status, detail) => {
      mainWindow?.webContents?.send("gateway-status", status, detail);
    };
    
    // 快速检查是否已经在运行（3秒超时，快速失败）
    updateStatus("正在检查 Gateway", "Quick check...");
    if (await checkGateway(3000)) {
      updateStatus("Gateway 已就绪", "Connecting...");
      setTimeout(() => mainWindow.loadURL(controlUiUrl), 500);
      return;
    }
    
    // 启动 Gateway
    updateStatus("正在启动 Gateway", "Starting openclaw gateway...");
    
    if (gatewayProcess && !gatewayProcess.killed) {
      gatewayProcess.kill();
    }
    
    const openclawInfo = getOpenClawPath();
    const gatewayArgs = ["gateway", "run", "--port", "18789", "--bind", "loopback"];
    
    if (openclawInfo.usePnpm) {
      // 开发模式：使用 pnpm openclaw
      gatewayProcess = spawn("pnpm", ["openclaw", ...gatewayArgs], {
        shell: true,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: openclawInfo.cwd,
      });
    } else if (openclawInfo.useNode) {
      // 开发模式：直接用 node 运行 entry.js
      gatewayProcess = spawn("node", [openclawInfo.entry, ...gatewayArgs], {
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: openclawInfo.cwd,
      });
    } else {
      // 打包模式：使用 Electron 作为 Node.js
      const env = { ...process.env, NODE_ENV: "production" };
      if (openclawInfo.runAsNode) {
        env.ELECTRON_RUN_AS_NODE = "1";  // 让 Electron 作为纯 Node.js 运行
      }
      gatewayProcess = spawn(openclawInfo.node, [openclawInfo.entry, ...gatewayArgs], {
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        cwd: openclawInfo.cwd,  // 在 node_modules 目录下运行
      });
    }
    
    gatewayProcess.stdout.on("data", (data) => {
      const text = data.toString();
      console.log("[Gateway]", text);
      // 检测到 Gateway 正在监听端口时，立即加载 UI
      if (text.includes("listening") || text.includes(":18789")) {
        updateStatus("Gateway 已就绪", "Loading Control UI...");
        // 停止等待循环
        if (gatewayWaitInterval) {
          clearInterval(gatewayWaitInterval);
          gatewayWaitInterval = null;
        }
        // 立即加载 Control UI
        setTimeout(() => mainWindow.loadURL(controlUiUrl), 300);
      }
    });
    
    gatewayProcess.stderr.on("data", (data) => {
      const text = data.toString();
      console.error("[Gateway Error]", text);
      // 显示错误到 UI
      updateStatus("Gateway 错误", text.substring(0, 100));
    });
    
    gatewayProcess.on("error", (err) => {
      console.error("Gateway 启动失败:", err);
      updateStatus("Gateway 启动失败", err.message);
    });
    
    gatewayProcess.on("exit", (code, signal) => {
      console.log(`[Gateway] 进程退出: code=${code}, signal=${signal}`);
      if (code !== 0 && code !== null) {
        updateStatus("Gateway 异常退出", `退出码: ${code}`);
      }
    });
    
    // 等待 Gateway 就绪
    updateStatus("等待 Gateway 就绪", "Checking health...");
    
    let attempts = 0;
    const maxAttempts = 60; // 最多等待 60 秒（1分钟）
    
    // 清除之前的等待循环（如果有）
    if (gatewayWaitInterval) {
      clearInterval(gatewayWaitInterval);
    }
    
    gatewayWaitInterval = setInterval(async () => {
      attempts++;
      updateStatus("等待 Gateway 就绪", `Attempt ${attempts}/${maxAttempts}...`);
      
      if (await checkGateway(5000)) { // 5秒超时用于轮询检查
        clearInterval(gatewayWaitInterval);
        gatewayWaitInterval = null;
        updateStatus("Gateway 已就绪", "Loading Control UI...");
        setTimeout(() => mainWindow.loadURL(controlUiUrl), 300);
      } else if (attempts >= maxAttempts) {
        clearInterval(gatewayWaitInterval);
        gatewayWaitInterval = null;
        updateStatus("Gateway 启动超时", "请检查日志或重启应用");
      }
    }, 1000);
  }
  
  startGatewayAndLoadUI();

  // 页面加载完成后显示窗口
  mainWindow.once("ready-to-show", () => {
    clearTimeout(showWindowTimeout);
    mainWindow.show();
  });
  
  // 页面加载失败时的错误处理
  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    console.error(`页面加载失败: ${errorCode} - ${errorDescription}`);
    clearTimeout(showWindowTimeout);
    mainWindow.show();
  });

}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 强制终止 Gateway 进程
function killGateway() {
  if (gatewayProcess && !gatewayProcess.killed) {
    console.log("[App] Killing Gateway process...");
    try {
      // Windows 需要使用 taskkill 来强制终止进程树
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(gatewayProcess.pid), "/f", "/t"], { shell: true });
      } else {
        gatewayProcess.kill("SIGTERM");
        setTimeout(() => {
          if (gatewayProcess && !gatewayProcess.killed) {
            gatewayProcess.kill("SIGKILL");
          }
        }, 1000);
      }
    } catch (err) {
      console.error("[App] Error killing gateway:", err);
    }
    gatewayProcess = null;
  }
}

// 强制终止 CLI 进程
function killCLI() {
  if (cliProcess && !cliProcess.killed) {
    console.log("[App] Killing CLI process...");
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(cliProcess.pid), "/f", "/t"], { shell: true });
      } else {
        cliProcess.kill("SIGTERM");
      }
    } catch (err) {
      console.error("[App] Error killing CLI:", err);
    }
    cliProcess = null;
  }
}

app.on("window-all-closed", () => {
  console.log("[App] All windows closed, cleaning up...");
  killGateway();
  killCLI();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  console.log("[App] Before quit, cleaning up...");
  // 注销所有全局快捷键
  globalShortcut.unregisterAll();
  killGateway();
  killCLI();
});

app.on("will-quit", () => {
  console.log("[App] Will quit, final cleanup...");
  killGateway();
  killCLI();
});

// IPC handlers
ipcMain.handle("load-config", async () => {
  try {
    const content = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    if (err.code === "ENOENT") {
      return {};
    }
    throw err;
  }
});

ipcMain.handle("save-config", async (_event, config) => {
  try {
    const configDir = join(homedir(), ".openclaw");
    await mkdir(configDir, { recursive: true });
    
    // 读取现有配置（如果存在），合并新配置
    let existingConfig = {};
    try {
      const existingContent = await readFile(CONFIG_PATH, "utf-8");
      existingConfig = JSON.parse(existingContent);
    } catch (err) {
      // 文件不存在或解析失败，使用空配置
      if (err.code !== "ENOENT") {
        console.warn("读取现有配置失败，将创建新配置:", err.message);
      }
    }
    
    // 深度合并配置
    const mergedConfig = deepMerge(existingConfig, config);
    
    // 保存到JSON文件
    await writeFile(CONFIG_PATH, JSON.stringify(mergedConfig, null, 2), "utf-8");
    return true;
  } catch (err) {
    console.error("保存配置失败:", err);
    throw err;
  }
});

// 深度合并对象
function deepMerge(target, source) {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach((key) => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(item) {
  return item && typeof item === "object" && !Array.isArray(item);
}

ipcMain.handle("execute-cli", async (_event, args) => {
  return new Promise((resolve, reject) => {
    const openclawInfo = getOpenClawPath();
    
    if (openclawInfo.usePnpm) {
      cliProcess = spawn("pnpm", ["openclaw", ...args], {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: openclawInfo.cwd,
      });
    } else if (openclawInfo.useNode) {
      cliProcess = spawn("node", [openclawInfo.entry, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: openclawInfo.cwd,
      });
    } else {
      const env = { ...process.env, NODE_ENV: "production" };
      if (openclawInfo.runAsNode) {
        env.ELECTRON_RUN_AS_NODE = "1";
      }
      cliProcess = spawn(openclawInfo.node, [openclawInfo.entry, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        cwd: openclawInfo.cwd,
      });
    }

    let stdout = "";
    let stderr = "";

    cliProcess.stdout.on("data", (data) => {
      stdout += data.toString();
      mainWindow?.webContents.send("cli-output", { type: "stdout", data: data.toString() });
    });

    cliProcess.stderr.on("data", (data) => {
      stderr += data.toString();
      mainWindow?.webContents.send("cli-output", { type: "stderr", data: data.toString() });
    });

    cliProcess.on("close", (code) => {
      resolve({ code, stdout, stderr });
      cliProcess = null;
    });

    cliProcess.on("error", (err) => {
      reject(err);
      cliProcess = null;
    });
  });
});

// 启动 Gateway（后台运行）
ipcMain.handle("start-gateway", async (_event) => {
  return new Promise((resolve, reject) => {
    // 如果已经在运行，直接返回成功
    if (gatewayProcess && !gatewayProcess.killed) {
      resolve({ success: true, message: "Gateway 已在运行" });
      return;
    }

    const openclawInfo = getOpenClawPath();
    const gatewayArgs = ["gateway", "--port", "18789", "--bind", "lan", "--verbose"];
    
    if (openclawInfo.usePnpm) {
      gatewayProcess = spawn("pnpm", ["openclaw", ...gatewayArgs], {
        shell: true,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: openclawInfo.cwd,
      });
    } else if (openclawInfo.useNode) {
      gatewayProcess = spawn("node", [openclawInfo.entry, ...gatewayArgs], {
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: openclawInfo.cwd,
      });
    } else {
      const env = { ...process.env, NODE_ENV: "production" };
      if (openclawInfo.runAsNode) {
        env.ELECTRON_RUN_AS_NODE = "1";
      }
      gatewayProcess = spawn(openclawInfo.node, [openclawInfo.entry, ...gatewayArgs], {
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        cwd: openclawInfo.cwd,
      });
    }

    let stdout = "";
    let stderr = "";

    gatewayProcess.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      mainWindow?.webContents.send("gateway-output", { type: "stdout", data: text });
      
      // 检测 Gateway 启动成功的标志
      if (text.includes("listening") || text.includes("Gateway") || text.includes("18789")) {
        // Gateway 可能已经启动，延迟一点打开浏览器（带 token）
        setTimeout(async () => {
          let controlUiUrl = "http://127.0.0.1:18789/";
          try {
            const content = await readFile(CONFIG_PATH, "utf-8");
            const config = JSON.parse(content);
            const token = config.gateway?.auth?.token || process.env.OPENCLAW_GATEWAY_TOKEN;
            if (token) {
              controlUiUrl = `http://127.0.0.1:18789/?token=${encodeURIComponent(token)}`;
            }
          } catch (err) {
            // 忽略错误，使用默认 URL
          }
          shell.openExternal(controlUiUrl).catch((err) => {
            console.error("打开浏览器失败:", err);
          });
        }, 1000);
      }
    });

    gatewayProcess.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      mainWindow?.webContents.send("gateway-output", { type: "stderr", data: text });
    });

    gatewayProcess.on("error", (err) => {
      gatewayProcess = null;
      reject(err);
    });

    // Gateway 是长期运行的进程，不等待它结束
    // 等待一小段时间确认启动成功，然后自动打开浏览器
    setTimeout(async () => {
      if (gatewayProcess && !gatewayProcess.killed) {
        // 读取配置中的 token
        let controlUiUrl = "http://127.0.0.1:18789/";
        try {
          const content = await readFile(CONFIG_PATH, "utf-8");
          const config = JSON.parse(content);
          const token = config.gateway?.auth?.token || process.env.OPENCLAW_GATEWAY_TOKEN;
          if (token) {
            controlUiUrl = `http://127.0.0.1:18789/?token=${encodeURIComponent(token)}`;
          } else {
            console.warn("未找到 Gateway token，可能需要手动输入");
          }
        } catch (err) {
          // 配置文件不存在或读取失败，使用默认 URL
          console.warn("读取配置失败，使用默认 URL:", err.message);
        }
        
        // 自动打开 Control UI
        shell.openExternal(controlUiUrl).catch((err) => {
          console.error("打开浏览器失败:", err);
        });
        resolve({ success: true, message: "Gateway 启动成功", pid: gatewayProcess.pid });
      } else {
        reject(new Error("Gateway 启动失败"));
      }
    }, 15000); // 15秒等待时间（5倍），确保 Gateway 完全启动
  });
});

// 停止 Gateway
ipcMain.handle("stop-gateway", async (_event) => {
  if (gatewayProcess && !gatewayProcess.killed) {
    gatewayProcess.kill();
    gatewayProcess = null;
    return { success: true, message: "Gateway 已停止" };
  }
  return { success: false, message: "Gateway 未运行" };
});

ipcMain.handle("show-security-dialog", async (_event, { riskLevel, content, reason }) => {
  if (!mainWindow) return { action: "cancel" };

  return new Promise((resolve) => {
    const options = {
      type: riskLevel === "high" ? "error" : "warning",
      title: riskLevel === "high" ? "高风险操作被拒绝" : "中风险操作确认",
      message: riskLevel === "high" ? reason : "检测到中风险操作，是否继续执行？",
      detail: content,
      buttons: riskLevel === "high" ? ["确定"] : ["执行", "取消"],
      defaultId: riskLevel === "high" ? 0 : 0,
      cancelId: 1,
    };

    dialog.showMessageBox(mainWindow, options).then((result) => {
      if (riskLevel === "high") {
        resolve({ action: "reject" });
      } else {
        resolve({ action: result.response === 0 ? "execute" : "cancel" });
      }
    });
  });
});

ipcMain.on("stop-cli", () => {
  if (cliProcess) {
    cliProcess.kill();
    cliProcess = null;
  }
});

// ============ Skill 执行相关 ============

let skillProcesses = {};

// 获取 skills 目录路径
function getSkillsPath() {
  if (isPackaged) {
    return join(process.resourcesPath, "skills");
  }
  return join(import.meta.dirname, "..", "..", "skills");
}

// 浏览文件夹
ipcMain.handle("browse-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: "选择输出目录",
  });
  
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// 打开文件夹
ipcMain.handle("open-folder", async (_event, folderPath) => {
  if (folderPath && existsSync(folderPath)) {
    shell.openPath(folderPath);
    return true;
  }
  return false;
});

// 执行 Skill
ipcMain.handle("run-skill", async (_event, skillId, options) => {
  return new Promise((resolve, reject) => {
    if (skillId !== "gamecode") {
      reject(new Error(`未知的 skill: ${skillId}`));
      return;
    }
    
    const skillsPath = getSkillsPath();
    const scriptPath = join(skillsPath, "game-code", "scripts", "game_gen.py");
    
    if (!existsSync(scriptPath)) {
      reject(new Error(`Skill 脚本不存在: ${scriptPath}`));
      return;
    }
    
    // 构建命令参数
    const args = ["--force"]; // 自动覆盖，避免交互式确认
    
    if (options.mode === "ai") {
      args.push("--mode", "ai");
      if (options.prompt) args.push("--prompt", options.prompt);
      args.push("--model", options.model || "gpt-4o");
      if (options.apiKey) {
        args.push("--api-key", options.apiKey);
      }
    } else {
      args.push("--mode", "template");
      args.push("--type", options.type || "snake");
      if (options.title) {
        args.push("--title", options.title);
      }
    }
    
    if (options.outputDir) {
      args.push("--output", options.outputDir);
    }
    
    // 查找 Python 路径 (尝试 python3, python, py)
    let pythonCmd = "python";
    try {
      execSync("python3 --version", { stdio: "ignore" });
      pythonCmd = "python3";
    } catch {
      try {
        execSync("python --version", { stdio: "ignore" });
        pythonCmd = "python";
      } catch {
        try {
          execSync("py --version", { stdio: "ignore" });
          pythonCmd = "py";
        } catch {
          reject(new Error("未找到 Python，请先安装 Python 3.10+"));
          return;
        }
      }
    }
    
    // 尝试使用 uv run (推荐) 或直接 python
    let spawnCmd, spawnArgs;
    try {
      execSync("uv --version", { stdio: "ignore" });
      spawnCmd = "uv";
      spawnArgs = ["run", scriptPath, ...args];
    } catch {
      spawnCmd = pythonCmd;
      spawnArgs = [scriptPath, ...args];
    }
    
    console.log(`[Skill] Running: ${spawnCmd} ${spawnArgs.join(" ")}`);
    
    const proc = spawn(spawnCmd, spawnArgs, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
      },
    });
    
    skillProcesses[skillId] = proc;
    
    let stdout = "";
    let stderr = "";
    
    proc.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      mainWindow?.webContents.send("skill-output", skillId, { type: "stdout", data: text });
    });
    
    proc.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      mainWindow?.webContents.send("skill-output", skillId, { type: "stderr", data: text });
    });
    
    proc.on("close", (code) => {
      delete skillProcesses[skillId];
      mainWindow?.webContents.send("skill-complete", skillId, { 
        success: code === 0, 
        code, 
        stdout, 
        stderr,
        outputDir: options.outputDir
      });
      resolve({ success: code === 0, code, stdout, stderr });
    });
    
    proc.on("error", (err) => {
      delete skillProcesses[skillId];
      mainWindow?.webContents.send("skill-complete", skillId, { 
        success: false, 
        error: err.message 
      });
      reject(err);
    });
  });
});

// 停止 Skill
ipcMain.on("stop-skill", (_event, skillId) => {
  const proc = skillProcesses[skillId];
  if (proc && !proc.killed) {
    console.log(`[Skill] Stopping skill: ${skillId}`);
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { shell: true });
    } else {
      proc.kill("SIGTERM");
    }
    delete skillProcesses[skillId];
  }
});

