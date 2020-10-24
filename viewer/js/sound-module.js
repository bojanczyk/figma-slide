import {
    manifest,
    userAgent,
    fileName,
    sendToServer
} from './viewer-module.js'

import {
    curEvent,
    eventIndex
} from "./event-module.js"


//there are four possible states for the sound
//"recording" means that we are recording sound
//"play" means that we are playing sound
//"pause" means that we have paused playing sound
//null means none of the above
export var soundState = null;
var playbackRate = 1;




//stop playing or recording, thus making the sound state null
export function soundStop() {
    if (soundState == "play") {
        globalAudio.pause();
    }

    if (soundState == "record") {
        soundState = null;
        mediaRecorder.stop();
    }
    if (soundState == "pause") {
        globalAudio.pause();
    }
    soundState = null;
    updateSoundIcon();
}

function currentSound() {
    return curEvent.audio;
}

function updateSoundIcon() {
    if (soundState == null) {
        if (curEvent.audio != null)
            soundIcon("play")
        else
            soundIcon(null);
    }
}

export function soundRecord() {
    if (userAgent() == "Safari") {
        userAlert("Sound recording does not work in Safari");
    } else {
        soundIcon("record");
        soundRecordCurrentEvent();
        soundState = "record";
    }
}

export function playButton() {
    if (soundState == "record")
        soundStop();
    else if (soundState == "play")
        soundPause();
    else
        soundPlay();
}

var globalAudio;


function soundPlay() {
    if (soundState == "pause") {
        soundIcon("pause");
        globalAudio.play();
        soundState = "play";
    } else {
        soundStop();
        if (soundPlayCurrentEvent()) {
            soundState = "play";
            soundIcon("pause");
        }
    }

}

function soundPause() {
    soundIcon("play");
    globalAudio.pause();
    soundState = "pause";
}


function soundIcon(icon) {
    if (icon != null) {
        document.getElementById("play-button").style.opacity = 1;
        if (icon == "pause") {
            document.getElementById("play-button").innerHTML = "pause"
        }
        if (icon == "play") {
            document.getElementById("play-button").innerHTML = "play_arrow"
        }
        if (icon == "record") {
            document.getElementById("play-button").innerHTML = "mic"
        }
    } else
        document.getElementById("play-button").style.opacity = 0;
}

function toggleSoundIcon(on) {
    if (on)
        document.getElementById("play-button").style.opacity = 1;
    else
        document.getElementById("play-button").style.opacity = 0;
}



//start recording the sound for a given event
function soundRecordCurrentEvent() {
    recordSound(curEvent);
}

var mediaRecorder;

function recordSound(event) {
    if (mediaRecorder != null) {
        if (mediaRecorder.state == "recording")
            mediaRecorder.stop();
    }

    navigator.mediaDevices.getUserMedia({
            audio: true
        })
        .then(stream => {
            mediaRecorder = new MediaRecorder(stream);
            mediaRecorder.start();

            const audioChunks = [];
            mediaRecorder.addEventListener("dataavailable", event => {
                audioChunks.push(event.data);
            });

            mediaRecorder.addEventListener("stop", () => {
                const audioBlob = new Blob(audioChunks);
                var audioURL = window.URL.createObjectURL(audioBlob);
                event.audio = new Audio(audioURL);
                event.audio.addEventListener('ended', function () {
                    changeEvent(1);
                })

                const index = eventIndex(event);
                const shortName = index;
                const longName = fileName(event.parent.id, shortName);

                manifest.soundDict[event.parent.id][index] = {
                    file: shortName
                };

                console.log("sending sound " + longName);

                const fr = new FileReader();
                fr.onload = function () {
                    var retmsg = {
                        type: 'wav',
                        slide: event.parent.id,
                        name: shortName,
                        file: Array.from(new Uint8Array(this.result))
                    };
                    sendToServer(retmsg).catch((e) => {
                        userAlert("Could not send this sound to the server: " + longName)
                    });

                    if (soundState == null)
                        sendSoundDatabase();
                };
                fr.readAsArrayBuffer(audioBlob);
            });
        });
}


function sendSoundDatabase() {
    sendToServer({
        type: 'json',
        slide: null,
        name: 'manifest',
        body: manifest
    }).
    catch((error) => {
        userAlert("Not connected to the slide server. Run it locally (it is called viewer/server.py).");
    });
}



function playbackRateChange(d) {
    if (playbackRate + d > 0.1 && playbackRate + d < 8) {
        playbackRate += d;
        globalAudio.playbackRate = playbackRate;
    }
    userAlert("Playback rate is now " + playbackRate.toFixed(1));

}

function soundPlayCurrentEvent() {
    if (currentSound() != null) {
        globalAudio = currentSound();
        globalAudio.playbackRate = playbackRate;
        globalAudio.currentTime = 0;
        globalAudio.play();
        return true;
    } else {
        //if the sound is not in the database
        userAlert("No sounds for this event");
        soundStop();
        return false;
    }
}

function soundFile(event) {
    const parent = event.parent.id;
    try {
        const index = eventIndex(event);
        const filename = manifest.soundDict[parent][index].file;
        return fileName(parent, filename + '.mp3');
    } catch (exception) {
        return null;
    }
}

export function loadSounds(node) {
    if (!(node.id in manifest.soundDict))
        manifest.soundDict[node.id] = {};

    for (let child of node.children) {
        const filename = soundFile(child);
        if (filename != null) {
            const audio = new Audio(filename);
            audio.addEventListener('ended', function () {
                changeEvent(1);
            })
            audio.addEventListener('loadeddata', (e) => {
                child.audio = audio;
                if (child == eventTree.children[0]) {
                    soundIcon("play");
                }
            })
        }
    }
}

//we begin by loading the sound database
soundIcon(null);