import Matrix from 'rpi-ws281x-native';
import io from 'socket.io-client';
import request from 'request';
import {Gpio} from 'onoff';
import shelljs from 'shelljs';
import os from 'os';
import cp from 'child_process';
import bleno from 'bleno';
import scanner from 'node-wifiscanner';
import fs from 'fs';

import config from './config';
import {love} from './pixels/default-emoji';
import {feel as alphabetFeel, letterMap} from './pixels/alphabet/standard';
import numbers from './pixels/numbers';
import {icons, iconmap} from './pixels/weather';

const {room, weatherApiKey, wrap} = config;
const ledCount = 64;
const socket = io('https://feelsbox-server-v2.herokuapp.com', {forceNew: true});
const weatherEndPoint = 'https://api.pirateweather.net/forecast';
const toggle = new Gpio(4, 'in', 'both');
const timers = [];
const interfaces = os.networkInterfaces();
const {wlan0: connections} = interfaces || {};
const [wifi] = connections || [];
const {address: localIP} = wifi || {};
const version = 1.2;

let isInitialized = false;
let viewState = 0;
let weatherReqFn;
let weatherTimerFn;
let weatherIconTimerFn;
var downTime = 0;
var clickBuffer;
// configure the ws281x strip
Matrix.init(ledCount);

socket.emit('joinroom', room, localIP, version);
socket.on('connect_error', error => {
    console.log('socket.io connection error', error);
});

setInterval(() => {
    socket.emit('joinroom', room, localIP, version);
}, 60000);

toggle.watch((err, value) => {
    if (value === 0) {
        downTime = new Date().getTime();
    } else if (value === 1) {
        // get timer diff
        const diff = new Date().getTime() - downTime;
        // if diff is greater than 5 seconds, shutdown
        if (downTime !== 0 && diff >= 5000) {
            restart();
            return;
        }
    }

    if (!err && value) {
        // if any clicks are already in progress, clear them
        clearTimeout(clickBuffer);
        clickBuffer = setTimeout(() => {
            setViewState();
            clickBuffer = null;
            // clear downtime
            downTime = 0;
        }, 300);
    }
});

const wifiConnection = new bleno.Characteristic({
    uuid: 'f3cbac8e-0628-4991-a7ea-22cb79e9febd',
    properties: ['write'],
    onWriteRequest: (data, offset, withoutResponse, callback) => {
        if (offset) {
            callback(bleno.Characteristic.RESULT_ATTR_NOT_LONG);
        } else {
            const [ssid, psk] = data.toString().split(':');
            const ssidStr = `ssid="${ssid}"`;
            const pskStr = `psk="${psk}"`;
            const parts = [
                'ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev',
                'update_config=1',
                'network={',
                `    ${ssidStr}`,
                `    ${pskStr}`,
                '}'
            ];

            fs.writeFile('/etc/wpa_supplicant/wpa_supplicant.conf', parts.join('\r\n'), err => {
                if (err) {
                    console.log(err);
                } else {
                    callback(bleno.Characteristic.RESULT_SUCCESS);
                    // on success, restart
                    restart();
                }
            });
        }
    }
});

const wifiSSIDs = new bleno.Characteristic({
    uuid: 'ae5f2916-d67d-42e5-b98c-753eb76416d9',
    properties: ['read'],
    onReadRequest: (offset, callback) => {
        scanner.scan((err, networks) => {
            if (err) {
                callback(bleno.Characteristic.RESULT_UNLIKELY_ERROR, null);
            } else {
                const ssids = networks.map(network => network.ssid).join(':|:');
                const data = new Buffer(ssids);

                let result = null;
                let code;

                if (offset > data.length) {
                    code = bleno.Characteristic.RESULT_INVALID_OFFSET;
                } else {
                    code = bleno.Characteristic.RESULT_SUCCESS;
                    result = data.slice(offset);
                }

                callback(code, result);
            }
        });
    }
});

const wifiSetupService = new bleno.PrimaryService({
    uuid: '6614b052-0c97-44ae-a417-fd8cac5fe295',
    characteristics: [wifiConnection, wifiSSIDs]
});

bleno.on('stateChange', state => {
    if (state === 'poweredOn') {
        bleno.startAdvertising('FEELSBOX', ['6614b052-0c97-44ae-a417-fd8cac5fe295'], err => {
            if (err) {
                console.log('ble error', err);
            }
        });
    }
});

bleno.on('advertisingStart', err => {
    if (!err) {
        bleno.setServices([wifiSetupService]);
    }
});

const sleep = duration => {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, duration);

        timers.push(timer);
    });
};

const clearTimers = () => {
    timers.forEach(timer => {
        clearTimeout(timer);
    });

    timers.length = 0;
};

const getWeather = (latitude, longitude) => {
    const opts = {
        url: `${weatherEndPoint}/${weatherApiKey}/${latitude}, ${longitude}`,
        method: 'GET',
        json: true
    };

    request(opts, (err, response, data) => {
        let low, high;

        const {
            currently: {
                icon,
                temperature: current,
                apparentTemperature: feelslike
            } = {},
            daily: {
                data: weather = []
            } = {}
        } = data;

        weather.forEach(item => {
            const {temperatureLow: min, temperatureHigh: max} = item;

            if (low === undefined || min < low) {
                low = min;
            }

            if (high === undefined || max > high) {
                high = max;
            }
        });

        renderWeather({
            icon,
            current,
            feelslike: parseInt(feelslike, 10),
            low,
            high
        });
    });
};

const renderWeatherDisplay = weather => {
    const pixelData = new Uint32Array(ledCount);
    const {icon, feelslike} = weather;
    const temperature = Math.min(Math.abs(feelslike), 99).toString().split('');
    let borderColor;

    if (feelslike <= 32) {
        // dark blue
        borderColor = '0x0000cc';
    } else if (feelslike > 32 && feelslike < 65) {
        // light blue
        borderColor = '0xadd8e6';
    } else if (feelslike >= 65 && feelslike < 85) {
        // green
        borderColor = '0x008000';
    } else {
        // orange
        borderColor = '0xff4500';
    }

    temperature.forEach((entry, index) => {
        let offset = 0;

        if (index === 0 && temperature.length === 1) {
            offset = 2;
        } else {
            offset = index === 0 ? 0 : 4;
        }

        const digit = numbers[entry];
        let start = 9 + offset;
        let current = start;

        // loop over rows
        for (let i = 0; i < 5; i++) {
            start = start + 8;
            current = start - 1;

            digit[i].forEach((row, idx) => {
                current++;

                if (row) {
                    pixelData[wrap ? current : invertValue(current)] = '0xfffffff';
                }
            });
        }
    });

    // temperature border
    let border = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
        16, 24, 32, 40, 48,
        56, 57, 58, 59, 60, 61, 62, 63
    ];

    if (temperature.length === 1) {
        border = border.concat([23, 31, 39, 47, 55]);
    }

    border.forEach(index => {
        pixelData[wrap ? index : invertValue(index)] = borderColor;
    });

    Matrix.render(pixelData);

    weatherIconTimerFn = setTimeout(() => {
        renderWeatherIcon(weather);
    }, 10000);
};

const renderWeatherIcon = weather => {
    const {icon, feelslike} = weather;
    const pixelData = new Uint32Array(ledCount);
    const iconPixels = icons[iconmap[icon]] || icons['sun'];

    iconPixels.forEach(item => {
        const {i, c} = item;

        pixelData[wrap ? i - 1 : invertValue(i - 1)] = `0x${c}`;
    });

    Matrix.render(pixelData);

    weatherTimerFn = setTimeout(() => {
        renderWeatherDisplay(weather);
    }, 10000);
};

const renderWeather = weather => {
    if (Matrix.state !== 'weather') {
        Matrix.init(ledCount, {brightness: 20});
        Matrix.state = 'weather';
    }

    renderWeatherDisplay(weather);
};

const prepareTickerTape = (words, opts = {}) => {
    const {duration: defaultDuration = 50, frames} = alphabetFeel;
    const {color = '8d8d8d', duration: definedDuration} = opts;
    const duration = definedDuration || defaultDuration;
    const letters = words.split('').map(letter => {
        const idx = letterMap.findIndex(char => char === letter);

        if (idx !== -1) {
            return frames[idx];
        }
    });
    const frameBuffer = 64;
    const allPixels = [];
    const frameCount = (letters.length * 8) + 8;
    const letterFrames = [];

    letters.forEach((frame, idx) => {
        const frameIdx = idx + 1;
        const start = frameIdx * frameBuffer;
        const {pixels = []} = frame;

        pixels.forEach(pixel => {
            const {color, position} = pixel;

            allPixels.push({
                frameIndex: frameIdx,
                position: position + start,
                originalPosition: position,
                row: Math.floor(position / 8)
            });
        });
    });

    for (let x = 0; x < frameCount; x++) {
        const pixels = [];

        for (const pixel of allPixels) {
            const {frameIndex, originalPosition, position: oldPosition, row} = pixel;

            let nextPosition = oldPosition - 1;

            const rowStart = (row * 8) + (frameIndex * frameBuffer);

            // if next position isn't in the same row, slide to next frame
            if (nextPosition < rowStart) {
                pixel.frameIndex = frameIndex - 1;

                const postFrameIndex = (pixel.frameIndex) * frameBuffer;
                const diminisher = Math.abs(postFrameIndex);

                nextPosition = ((row + 1) * 8) + postFrameIndex - 1;
            }

            pixel.position = nextPosition;
            // save into individual frames
            pixels.push({color, position: nextPosition});
        }

        letterFrames.push({pixels});
    }

    return {
        feel: {
            duration,
            frames: letterFrames,
            repeat: true
        }
    };
};

const showFeeling = async data => {
    const {feel} = data;
    const {duration: defaultDuration = 1000, frames = [], repeat = false, reverse = false} = feel;

    if (!isInitialized) {
        isInitialized = initialize();

        await sleep(10);
    }

    clearTimers();

    if (frames.length === 1) {
        const [frame] = frames;

        renderFrame(frame);
    } else {
        const loop = async (curFrames, skip) => {
            let idx = -1;

            for (const frame of curFrames) {
                idx++;

                if ((idx === 0 && skip) || !isInitialized) {
                    continue;
                }

                const {duration: frameDuration} = frame;
                const duration = frameDuration || defaultDuration;

                renderFrame(frame);

                await sleep(duration);
            }

            if (repeat && isInitialized) {
                const frames = reverse ? curFrames.reverse() : curFrames;

                await loop(frames, reverse);
            }
        };

        await loop(frames);
    }
};

const renderFrame = frame => {
    const {brightness = 100, pixels = []} = frame;
    const pixelData = new Uint32Array(ledCount);

    Array.from(Array(64).keys()).forEach((row, idx) => {
        const pixel = pixels.find(pix => pix.position === idx);
        let color = '000';

        if (pixel) {
            ({color} = pixel);
        }

        pixelData[wrap ? idx : invertValue(idx)] = `0x${color}`;
    });

    if (isInitialized) {
        Matrix.render(pixelData);
    }
};

const initialize = () => {
    Matrix.init(ledCount);

    isInitialized = true;

    return isInitialized;
};

const resetWeather = () => {
    const {state = null} = Matrix;

    if (state) {
        delete Matrix.state;
    }

    clearInterval(weatherReqFn);
    clearTimeout(weatherTimerFn);
    clearTimeout(weatherIconTimerFn);
};

const teardown = () => {
    resetWeather();

    if (isInitialized) {
        Matrix.reset();

        isInitialized = false;
    }
};

const invertValue = value => {
    const row = parseInt(value / 8);
    const needsInversion = !(row % 2);

    let fixedValue = value;

    if (needsInversion) {
        const rowStart = row * 8;
        const rowEnd = rowStart + 7;
        const distanceFromStart = value - rowStart;

        fixedValue = rowEnd - distanceFromStart;
    }

    return fixedValue;
};

const restart = () => {
    teardown();

    shelljs.exec('reboot -h now');
};

const setBrightness = brightness => {
    const convertedBrightness = Math.round(brightness / 100 * 255);

    Matrix.setBrightness(convertedBrightness);
};

const exitHandler = () => {
    socket.close();

    teardown();

    process.nextTick(() => {
        process.exit();
    });
}

socket.on('emote', data => {
    resetWeather();
    showFeeling(data);
});

socket.on('words', data => {
    const {duration = 50, words} = data;
    const feeling = prepareTickerTape(words, {duration});

    showFeeling(feeling);
});

socket.on('update', () => {
    cp.execSync('cd /usr/local/code/feelsbox && git pull origin v2 && npm install');

    restart();
});

socket.on('restart', restart);

socket.on('brightness', setBrightness);

socket.on('stop', () => {
    teardown();
});

socket.on('weather', data => {
    const {latitude, longitude} = data;

    resetWeather();
    clearTimers();
    weatherReqFn = setInterval(() => {
        getWeather(latitude, longitude);
    }, 600000);

    getWeather(latitude, longitude);
});

// catches ctrl+c event
process.on('SIGINT', exitHandler);

// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler);
process.on('SIGUSR2', exitHandler);

// catches uncaught exceptions
process.on('uncaughtException', exitHandler);

// show initial emoji on startup
showFeeling({feel: love});
