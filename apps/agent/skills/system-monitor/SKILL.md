---
name: system-monitor
description: Check the local system status (CPU, RAM, Disk, Uptime) using standard Linux commands.
user-invocable: true
metadata:
  emoji: 🖥️
  requires:
    bins: ["top", "free", "df", "uptime"]
---

# System Monitoring

You can check the health and status of the server/device you are running on (Raspberry Pi/Docker) using standard Linux commands.

## Available Commands

### CPU & Processes
- **Memory**: `free -h`
- **CPU Load**: `top -b -n 1 | head -n 20` (Batch mode, top 20 lines)
- **Uptime**: `uptime`

### Storage
- **Disk Usage**: `df -h` (Human readable)

### Network
- **IP Address**: `hostname -I`
- **Connections**: `netstat -tuln` (if available)

## Usage Tips
- If the user asks "How are you doing?", check your resources!
- If the user asks "Are you running out of space?", check `df -h`.
- Report values in a human-friendly summary (e.g., "I'm using 200MB of RAM out of 4GB").
