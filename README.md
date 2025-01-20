# feelsbox
FeelsBox

## Configuration

### Require Network Connection on Startup
```
sudo raspi-config
```
In **3: Boot Options**, set **B2: Wait for Network at Boot** to true

### Startup Script
```
// /etc/rc.local

#!/bin/sh -e

cd /usr/local/code/feelsbox && git pull origin v2 && npm start &
exit 0
```

## Debugging
For local debugging, use:

`const socket = io('https://feelsbox.ngrok.io', {forceNew: true});`