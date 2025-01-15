const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const { HttpsProxyAgent } = require("https-proxy-agent");
const readline = require("readline");
const user_agents = require("./config/userAgents");
const settings = require("./config/config");
const { sleep, loadData, getRandomNumber, saveToken, isTokenExpired, saveJson, decodeJWT } = require("./utils");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

class ClientAPI {
  constructor(queryId, accountIndex, proxy = null) {
    this.headers = {
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
      "Content-Type": "application/json",
      Origin: "https://miniapp.uxuy.one",
      referer: "https://miniapp.uxuy.one/",
      "Sec-Ch-Ua": '"Not/A)Brand";v="99", "Google Chrome";v="115", "Chromium";v="115"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
    };
    this.baseURL = "https://miniapp.uxuy.one/rpc";
    this.queryId = queryId;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
    this.session_name = null;
    this.session_user_agents = this.#load_session_data();
    this.tokens = {};
    this.rfTokens = {};
    this.hasProxy = !!proxy;
  }

  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    console.log(`[Account ${this.accountIndex + 1}] Create user agent...`.blue);
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  #set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }

  async log(msg, type = "info") {
    const timestamp = new Date().toLocaleTimeString();
    const accountPrefix = `[Account ${this.accountIndex + 1}]`;
    const ipPrefix = this.hasProxy ? (this.proxyIP ? `[${this.proxyIP}]` : "[Unknown IP]") : "[No Proxy]";
    let logMessage = "";

    switch (type) {
      case "success":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
        break;
      case "error":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
        break;
      case "warning":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
        break;
      case "custom":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.magenta;
        break;
      default:
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
    }
    console.log(logMessage);
  }

  async createUserAgent() {
    try {
      const dataParse = decodeJWT(this.queryId);
      const userData = await JSON.parse(dataParse.payload.user);
      this.session_name = userData.userId;
      this.#get_user_agent();
    } catch (error) {
      this.log(`Unable to create user agent, try getting another token: ${error.message}`, "error");
      return;
    }
  }

  async checkProxyIP() {
    if (!this.hasProxy) {
      this.proxyIP = "No Proxy";
      return "No Proxy";
    }

    try {
      const proxyAgent = new HttpsProxyAgent(this.proxy);
      const response = await axios.get("https://api.ipify.org?format=json", { httpsAgent: proxyAgent });
      if (response.status === 200) {
        this.proxyIP = response.data.ip;
        return response.data.ip;
      } else {
        throw new Error(`Cannot check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error checking proxy IP: ${error.message}`);
    }
  }

  async makeRequest(url, method, data = {}, retries = 3) {
    const headers = {
      ...this.headers,
      Authorization: `Bearer ${this.queryId}`,
    };
    
    const config = {
      method,
      url,
      data,
      headers,
      timeout: 30000,
    };

    if (this.hasProxy) {
      config.httpsAgent = new HttpsProxyAgent(this.proxy);
    }

    let currRetries = 0,
      success = false;
    do {
      try {
        const response = await axios(config);
        success = true;
        return { success: true, data: response.data.result };
      } catch (error) {
        this.log(`Request failed: ${url} | ${error.message} | trying again...`, "warning");
        success = false;
        await sleep(settings.DELAY_BETWEEN_REQUESTS);
        if (currRetries == retries) return { success: false, error: error.message };
      }
      currRetries++;
    } while (currRetries < retries && !success);
  }

  async auth() {
    const headers = {
      ...this.headers,
    };
    let currRetries = 0,
      success = false;
    const url = `https://miniapp.uxuy.one/jwt`;
    
// Read the refer code from the file
const referCode = fs.readFileSync('refer.txt', 'utf8').trim();

const formData = new FormData();
const data = this.queryId;

formData.append("user", JSON.stringify(data.user));
formData.append("chat_instance", "-298404396458566810");
formData.append("chat_type", "channel");
formData.append("auth_date", data.auth_date);
formData.append("signature", data.signature);
formData.append("hash", data.hash);

// Dynamically set the start_param from the file
formData.append("start_param", referCode);

    try {
      const response = await axios.post(url, formData, { headers });
      success = true;
      return { success: true, data: response.data };
    } catch (error) {
      success = false;
      return { success: false, error: error.message };
    }
  }

  async getUserInfo() {
    return this.makeRequest(`${this.baseURL}`, "post", {
      method: "wallet_myPoint",
      params: [],
      id: 896770937,
      jsonrpc: "2.0",
    });
  }

  async getWalletRegister() {
    return this.makeRequest(`${this.baseURL}`, "post", {
      method: "wallet_register",
      params: [
        "046cfed8d984f6bf11c27de9666261c3457d5dc2ec502ba7c5facac9618c2298bab0e8bb4b665fd8d567aad080141a0caa013a40765e602da565fcda847b39a7c1",
        "2d9ede87cc10737b754e899a2612cfdbb2d17ec942345f4d61e3a217dcd005ea",
        {
          tron: ["044c6874089604b8c0d7ea527add873fa5b4cfbe352daa7cefab42cd1adab20879f7db091c25dd08ce98a383012979fe30e45ec9db3564ff6748319b34b827c74f", ""],
          ton: [
            "043a92ee4a3af11541d5ef85a01696654381a144c6b3d777913e8f72caf0a468e0e13f47b078ce120391c2f451db51fc5f5e19f3e87186b9e02ec30c0a650de363",
            "6388cf477388a2566cb0af340e633ac4e036a6147cea80eb704a22de571a3a77",
          ],
          sui: [
            "043dcd93ff9fbdd46c5eb347ffc369f9e344ba8f06aa155c5ce98aecc24ee3f2b0e7c59b0d51e6d575c1bfc80842bc861628787e3d93faadc43f06df9a98734bba",
            "111ac9ce78462aedba8642a0ee63f7e23c9d4acce6b6021b7a2e414365ba3ad7",
          ],
          aptos: [
            "042d0ec4bd6885d1097aafff2080248579e37ab504609bc0974e2f0d0394bb6ca3a4b5103f8140e9f251fa1129616920293a9b92c07a09ae52a7e65d31f7f8732e",
            "8f6917557bfea543b3aedeb8b27e61cec5ff7ae8b76c084396cbc621c6a5b453",
          ],
        },
      ],
      id: 896770937,
      jsonrpc: "2.0",
    });
  }

  async getFarmInfo() {
    return this.makeRequest(`${this.baseURL}`, "post", {
      method: "wallet_getFarmInfo",
      params: [],
      id: 78611763,
      jsonrpc: "2.0",
    });
  }

  async claimFarm(groupid, id) {
    return this.makeRequest(`${this.baseURL}`, "post", {
      method: "wallet_claimFarm",
      params: [groupid, id, ""],
      id: 542792293,
      jsonrpc: "2.0",
    });
  }

  async startFarm(groupid, id) {
    return this.makeRequest(`${this.baseURL}`, "post", {
      method: "wallet_startFarm",
      params: [groupid, id],
      id: 377602545,
      jsonrpc: "2.0",
    });
  }

  async myPoint() {
    return this.makeRequest(`${this.baseURL}`, "post", {
      method: "wallet_myPoint",
      params: [],
      id: 565051978,
      jsonrpc: "2.0",
    });
  }

  async getTasks() {
    return this.makeRequest(`${this.baseURL}`, "post", {
      method: "wallet_adsList2",
      params: [false],
      id: 649710614,
      jsonrpc: "2.0",
    });
  }

  async completeTask(id) {
    return this.makeRequest(`${this.baseURL}`, "post", {
      method: "wallet_adsClick",
      params: [id],
      id: 297490398,
      jsonrpc: "2.0",
    });
  }

  async getTasksTransaction() {
    return this.makeRequest(`${this.baseURL}`, "post", {
      method: "wallet_taskList",
      params: [false],
      id: 179679312,
      jsonrpc: "2.0",
    });
  }

  async claimTask(id) {
    return this.makeRequest(`${this.baseURL}`, "post", {
      method: "wallet_adsClaim",
      params: [id, ""],
      id: 432482742,
      jsonrpc: "2.0",
    });
  }

  async getValidToken() {
    const userId = this.session_name;
    const existingToken = this.queryId;

    const isExp = isTokenExpired(existingToken);
    if (existingToken && !isExp) {
      this.log("Use valid tokens", "success");
      return existingToken;
    } else {
      this.log("Token does not exist or has expired, ignore...", "warning");
    }
    return null;
  }

  async verifyTasks() {
    return this.makeRequest(`${this.baseURL}`, "post", {
      method: "wallet_adsList3",
      params: [false],
      id: 940300286,
      jsonrpc: "2.0",
    });
  }

  async handleTasks() {
    const resTasks = await this.getTasks();
    if (!resTasks.success) {
      this.log("Unable to get task list", "error");
      return;
    }
  
    let tasks = resTasks.data?.items || [];
    tasks = tasks.filter((t) => !t.finished && !settings.SKIP_TASKS.includes(t.id));
    
    if (tasks.length === 0) {
      this.log("There are no tasks to do", "warning");
      return;
    }
  
    for (const task of tasks) {
      try {
        if (!task.clicked) {
          this.log(`Complete the mission ${task.name} ...`);
          const completeResult = await this.completeTask(task.id);
          
          if (!completeResult.success) {
            this.log(`Unable to complete the task ${task.name}`, "error");
            continue;
          }
          await sleep(2);
        }
  
        const verifyResult = await this.verifyTasks();
        if (!verifyResult.success || !verifyResult.data?.items) {
          this.log(`Unable to verify task ${task.name}`, "error");
          continue;
        }
  
        const verifiableTasks = verifyResult.data.items
          .filter(t => t.finished && !t.rewarded);
  
        for (const verifiedTask of verifiableTasks) {
          try {
            const resClaim = await this.claimTask(verifiedTask.id);
            
            if (resClaim.success) {
              this.log(
                `Get the quest ${verifiedTask.name} success | ` +
                `Award: ${verifiedTask.awardAmount}`, 
                "success"
              );
              
              await sleep(1);
            } else {
              this.log(
                `Unable to accept quest ${verifiedTask.name}`, 
                "error"
              );
            }
          } catch (error) {
            this.log(
              `Quest reward error ${verifiedTask.id}: ${error.message}`, 
              "error"
            );
          }
        }
        const pendingTasks = verifyResult.data.items
          .filter(t => !t.finished && !t.rewarded);
        
        for (const pendingTask of pendingTasks) {
        }
  
      } catch (error) {
        this.log(`Mission processing error ${task.id}: ${error.message}`, "error");
        continue;
      }
    }
  }

  async handleFarming() {
    const farmInfo = await this.getFarmInfo();
    if (farmInfo.success) {
      const { coolDown, sysTime, farmTime, finished, id, groupId, rewarded, awardAmount } = farmInfo.data;
      const finishTime = farmTime + coolDown;
      const currentTime = sysTime;

      if (currentTime < finishTime) {
        const remainingTime = finishTime - currentTime;
        const remainingMinutes = Math.floor(remainingTime / 60);
        const remainingSeconds = remainingTime % 60;
        return this.log(`Not time to claim yet, need to wait ${remainingMinutes} phút ${remainingSeconds} second.`, "warning");
      }

      if (finished && !rewarded) {
        await sleep(1);
        const resClaim = await this.claimFarm(groupId, id);
        if (resClaim.success) {
          this.log(`Claim farm successful | Reward: ${awardAmount}`, "success");
        }
        await sleep(1);
        const resStart = await this.startFarm(groupId, id);
        if (resStart.success) {
          this.log(`Start farming successfully!`, "success");
        }
        return;
      }

      if (rewarded) {
        const resStart = await this.startFarm(groupId, id);
        if (resStart.success) {
          this.log(`Start farming successfully!`, "success");
        }
        return;
      }
    }
  }

  async runAccount() {
    try {
      this.proxyIP = await this.checkProxyIP();
    } catch (error) {
      this.log(`Cannot check proxy IP: ${error.message}`, "warning");
      return;
    }

    const accountIndex = this.accountIndex;
    const initData = this.queryId;
    const dataParse = decodeJWT(initData);
    const userData = await JSON.parse(dataParse.payload.user);
    const firstName = userData.firstName || "";
    const lastName = userData.lastName || "";
    this.session_name = userData.userId;

    const timesleep = getRandomNumber(settings.DELAY_START_BOT[0], settings.DELAY_START_BOT[1]);
    const proxyStatus = this.hasProxy ? this.proxyIP : "No Proxy";
    console.log(`[*] Account ${accountIndex + 1} | ${firstName + " " + lastName} | ${proxyStatus} | Start later ${timesleep} second...`.green);
    
    this.#set_headers();
    await sleep(timesleep);

    const token = await this.getValidToken();
    if (!token) {
      this.log("Token not found or token expired..ignore account", "error");
      return;
    }

    const data = await this.getWalletRegister();
    const farmInfo = await this.getFarmInfo();

    if (data.success && data?.data?.alias && farmInfo?.data?.token) {
      const { decimals, balance } = farmInfo?.data?.token;
      const formattedBalance = (parseInt(balance) / Math.pow(10, decimals)).toFixed(decimals);
      this.log(`Username: ${data?.data?.alias[0]} | Balance: ${formattedBalance} UP`);
    }

    await this.handleTasks();
    await this.handleFarming();
  }
}

async function runWorker(workerData) {
  const { queryId, accountIndex, proxy } = workerData;
  const to = new ClientAPI(queryId, accountIndex, proxy);
  try {
    await Promise.race([
      to.runAccount(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 24 * 60 * 60 * 1000))
    ]);
    parentPort.postMessage({
      accountIndex,
    });
  } catch (error) {
    parentPort.postMessage({ accountIndex, error: error.message });
  } finally {
    if (!isMainThread) {
      parentPort.postMessage("taskComplete");
    }
  }
}

async function main() {
  const queryIds = loadData("data.txt");
  const proxies = loadData("proxy.txt");

  console.log(`Data: ${queryIds.length} account`);
  console.log(`Proxy: ${proxies.length} proxy`);

  queryIds.map(async (val, i) => {
    const proxy = i < proxies.length ? proxies[i] : null;
    await new ClientAPI(val, i, proxy).createUserAgent()
  });

  await sleep(1);
  while (true) {
    let currentIndex = 0;
    const errors = [];

    while (currentIndex < queryIds.length) {
      const workerPromises = [];
      const batchSize = Math.min(settings.MAX_THEADS, queryIds.length - currentIndex);
      
      for (let i = 0; i < batchSize; i++) {
        const proxy = currentIndex < proxies.length ? proxies[currentIndex] : null;
        
        const worker = new Worker(__filename, {
          workerData: {
            queryId: queryIds[currentIndex],
            accountIndex: currentIndex,
            proxy: proxy,
          },
        });

        workerPromises.push(
          new Promise((resolve) => {
            worker.on("message", (message) => {
              if (message === "taskComplete") {
                worker.terminate();
              }
              resolve();
            });
            worker.on("error", (error) => {
              console.log(`Worker error for account ${currentIndex}: ${error.message}`);
              worker.terminate();
              resolve();
            });
            worker.on("exit", (code) => {
              worker.terminate();
              if (code !== 0) {
                errors.push(`Worker for account ${currentIndex} exit with code: ${code}`);
              }
              resolve();
            });
          })
        );

        currentIndex++;
      }

      await Promise.all(workerPromises);

      if (errors.length > 0) {
        errors.length = 0;
      }

      if (currentIndex < queryIds.length) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    await sleep(3);
    console.log(`
░▀▀█░█▀█░▀█▀░█▀█
░▄▀░░█▀█░░█░░█░█
░▀▀▀░▀░▀░▀▀▀░▀░▀
╔══════════════════════════════════╗
║                                  ║
║  ZAIN ARAIN                      ║
║  AUTO SCRIPT MASTER              ║
║                                  ║
║  JOIN TELEGRAM CHANNEL NOW!      ║
║  https://t.me/AirdropScript6              ║
║  @AirdropScript6 - OFFICIAL      ║
║  CHANNEL                         ║
║                                  ║
║  FAST - RELIABLE - SECURE        ║
║  SCRIPTS EXPERT                  ║
║                                  ║
╚══════════════════════════════════╝[*] All accounts completed, waiting ${settings.TIME_SLEEP} minute...`.magenta);
    await sleep(settings.TIME_SLEEP * 60);
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.log("Error:", error);
    process.exit(1);
  });
} else {
  runWorker(workerData);
}

module.exports = ClientAPI;