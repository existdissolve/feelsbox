import Matrix from 'rpi-ws281x-native';
import io from 'socket.io-client';
import request from 'request';
import {Gpio} from 'onoff';
import shelljs from 'shelljs';
import os from 'os';
import cp from 'child_process';

import config from './config';
import {love} from './pixels/default-emoji';
import {feel as alphabetFeel, letterMap} from './pixels/alphabet/standard';
import numbers from './pixels/numbers';
import {icons, iconmap} from './pixels/weather';

const {apiKey, latitude, longitude, room, wrap} = config;
const ledCount = 64;
const socket = io('https://feelsbox-server-v2.herokuapp.com', {forceNew: true});
const weatherEndPoint = 'https://api.darksky.net/forecast';
const toggle = new Gpio(4, 'in', 'both');
const timers = [];
const interfaces = os.networkInterfaces();
const {wlan0: connections} = interfaces;
const [wifi] = connections || {};
const {address: localIP} = wifi;
const version = 1.2;

let isInitialized = false;
let viewState = 0;
var downTime = 0;
var clickBuffer;

// configure the ws281x strip
Matrix.init(ledCount);

socket.emit('joinroom', room, localIP, version);

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
            console.log(diff, 'restart');
            restart();
            return;
        }
    }

    if (!err && value) {
        // if any clicks are already in progress, clear them
        clearTimeout(clickBuffer);
        clickBuffer = setTimeout(() => {
            console.log('button up', viewState);
            setViewState();
            clickBuffer = null;
            // clear downtime
            downTime = 0;
	}, 300);
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
        const loop = async(curFrames, skip) => {
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

const teardown = () => {
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

    console.log('restarting');

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

socket.on('weather', () => {
    // TODO: fix this
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
