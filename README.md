# 工创小车 · BLE 调参台

一个单页 Web Bluetooth 工具，用 Android Chrome 通过 **DX-BT24** 透传，读取 STM32 调试串口的电机状态，并实时画曲线、在发车前修改启动参数。

> 本目录只包含网页文件，不修改固件源码。  
> 固件仍然是 USART1、115200 8N1、ASCII 行协议。

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | 页面结构 |
| `styles.css` | 深色移动端样式 |
| `app.js` | BLE 连接、协议解析、Canvas 曲线、参数下发 |
| `README.md` | 本说明 |

## 一、先确认模块和固件

### 1. DX-BT24 串口

模块默认是 **9600**，而当前固件 USART1 是 **115200**。

用 USB-TTL 在**未连接手机**时发 AT 指令（每条以 `\r\n` 结尾）：

```text
AT
AT+BAUD7
AT+NAMEBT24
AT+NOTI1
```

`AT+BAUD7` 表示 115200。设置后断电重启模块。

如果要恢复默认 UUID：

```text
AT+UUID0xFFE0
AT+CHAR0xFFE1
AT+WRITE0xFFE2
```

重启手机蓝牙后生效。

### 2. 接线

```text
DX-BT24 TX  -> STM32 PA10 / USART1_RX
DX-BT24 RX  <- STM32 PA9  / USART1_TX
GND         -> GND
VCC         -> 按模块板标称供电
```

注意：

- 裸模块 VCC 标称 3.3V；
- 带底板的 DX-BT24 模块常见标称 3.6~6V，以实物丝印为准；
- 一定要共地；
- 蓝牙只在调试时插，下载时拔掉，避免和 USART1 下载冲突。

### 3. 固件协议

页面使用现有调试命令：

```text
GET
SET ARM 120
SET ARMMS 200
SET BRK 320
SET BRKMS 700
SET SMS 1000
SET SLEW 600
SAVE
LOAD
STREAM 1
STREAM 0
RATE 200
DEFAULT
```

`TGT` 现在由发车时的电位器决定，网页不再发送 `SET TGT`。  
`SAVE` 把当前 6 个曲线参数写入内部 Flash；`LOAD` 重新从 Flash 加载。  
`SET` 仍然只改 RAM，必须再点“保存到小车”才会掉电保存。

状态行：

```text
$CAR,ST=0,LOCK=0,TGT=900,DUTY=0,CCR=0,ARM=100,ARMMS=150,BRK=300,BRKMS=600,SMS=1200,SLEW=800
```

发车后固件会锁定，`SET` / `SAVE` / `LOAD` / `DEFAULT` 返回：

```text
ERR LOCKED
```

`DEFAULT` 只恢复 RAM 默认值；如果要让默认值也掉电保存，先 `DEFAULT`，再 `SAVE`。  
网页会自动把参数控件置灰。

## 二、打开网页

### 方式 A：放到 HTTPS 静态站点（推荐）

把本目录三个文件上传到任意 HTTPS 静态站点，例如：

- GitHub Pages
- Cloudflare Pages
- Netlify
- 自己的 HTTPS 服务器

然后 Android Chrome 打开站点地址。

> Web Bluetooth 要求 **安全上下文**。  
> `file://` 不行；普通 `http://192.168.x.x` 也不行。

### 方式 B：本机 HTTP + adb reverse（适合调试）

电脑上：

```bash
cd tools/ble-dashboard
python -m http.server 8080 --bind 127.0.0.1
```

手机用 USB 连接电脑，开启 USB 调试，然后：

```bash
adb reverse tcp:8080 tcp:8080
```

手机 Chrome 打开：

```text
http://localhost:8080
```

`localhost` 在 Chrome 里属于安全上下文，可以在 Android 上使用 Web Bluetooth。  
如果不用 adb，就用 HTTPS 隧道或静态站点。

## 三、连接步骤

1. 给车上电，确认 STM32 和 DX-BT24 工作。
2. Android Chrome 打开页面。
3. 点 **连接蓝牙**。
4. 在系统弹窗里选择 `BT24` / `DX-BT24`。
5. 连接成功后页面自动发送：

```text
STREAM 0
RATE 200
STREAM 1
GET
```

6. 曲线开始刷新，参数面板可编辑。
7. 发车前修改参数，点 **应用全部**。
8. 按车上按键发车；收到 `LOCK=1` 后参数自动锁定。
9. 比赛时点 **停止**，关闭 `STREAM`，避免调试输出占用主循环。

如果设备名不是 `BT24`，勾选 **显示全部设备** 再连接。

## 四、页面功能

### 实时状态

- `DUTY`：当前占空比，千分比
- `TGT`：目标速度，千分比
- `CCR`：TIM2 比较值，0~399
- `ST`：0 停止，1 启动曲线中，2 到目标
- `LOCK`：目标是否锁定
- `STREAM`：数据流是否开启

### 曲线

- 青色：`DUTY`
- 橙色：`TGT`
- 窗口：最近 60 秒
- 采样来源：`STREAM 1` 的 `$CAR` 行，或手动 `GET`

### 参数

| 参数 | 含义 | 范围 |
|---|---|---|
| `ARM` | 预励磁占空比 | 0~1000 |
| `ARMMS` | 预励磁时间 | 0~5000 ms |
| `BRK` | 死点占空比 | 0~1000 |
| `BRKMS` | 线性爬升时间 | 1~10000 ms |
| `SMS` | S 曲线时间 | 1~10000 ms |
| `SLEW` | 运行中过渡时间 | 1~10000 ms |

“应用全部”会按顺序发送 6 条 `SET`，最后发 `GET` 刷新状态。  
“保存到小车”发送 `SAVE`，把这 6 个曲线参数写入内部 Flash；`TGT` 由电位器控制，不保存。

## 五、常见问题

### 1. 页面提示不支持 Web Bluetooth

- 必须 Android Chrome；
- 必须 HTTPS 或 `localhost`；
- 不要用微信/QQ 内置浏览器；
- 不要直接双击 `index.html`。

### 2. 搜不到设备

- 模块是否上电；
- 手机蓝牙是否打开；
- 是否被其他手机/电脑占用；
- 设备名是否被改过，勾选“显示全部设备”；
- Android 可能需要开启“位置信息”权限。

### 3. 连接后收不到数据

- DX-BT24 串口是否为 115200；
- STM32 USART1 是否为 115200 8N1；
- TX/RX 是否交叉；
- 是否共地；
- 先用 USB-TTL 直接看 STM32 是否有 `$CAR` 输出。

### 4. 数据乱码

- 波特率不匹配；
- 模块被设置成 9600 默认值；
- 检查 `AT+BAUD` 返回值。

### 5. 发车后参数不能改

这是固件设计：

```text
ERR LOCKED
```

需要复位/重新上电后才能再次设置。

### 6. 开数据流后电机变卡

当前固件已把调试串口发送改成 DMA 环形队列，正常不会明显卡主循环。

```text
比赛：点“停止”
调参：RATE 500 或 1000
```

如果仍然卡，先确认 USART1_TX DMA1_Channel4 已配置，且 `BspDebug_Update()` 在主循环里被调用。

## 六、BLE UUID

```text
Service              FFE0
Notify / Write       FFE1
Write only           FFE2
```

完整 128 位写法：

```text
0000ffe0-0000-1000-8000-00805f9b34fb
0000ffe1-0000-1000-8000-00805f9b34fb
0000ffe2-0000-1000-8000-00805f9b34fb
```

如果模块被 `AT+UUID` / `AT+CHAR` 改过，需要同步修改 `app.js` 顶部的 `BLE` 常量。

## 七、安全说明

- 本页面不会发送发车/启动命令；
- 发车仍由车上按键完成；
- 参数只在 `LOCK=0` 时允许修改；
- `SAVE` 只在电机停止且未锁定时执行；
- 调试完成后建议断开蓝牙，避免手机意外发命令。
