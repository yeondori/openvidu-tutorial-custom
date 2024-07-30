import { useEffect, useRef, useState } from "react";
import {
    DataPacket_Kind,
    LocalVideoTrack,
    RemoteParticipant,
    RemoteTrack,
    RemoteTrackPublication,
    Room,
    RoomEvent
} from "livekit-client";
import "./App.css";
import VideoComponent from "./components/VideoComponent";
import AudioComponent from "./components/AudioComponent";
import { Simulate } from "react-dom/test-utils";
import error = Simulate.error;

type TrackInfo = {
    trackPublication: RemoteTrackPublication;
    participantIdentity: string;
};

let APPLICATION_SERVER_URL = "";
let LIVEKIT_URL = "";
configureUrls();

function configureUrls() {
    if (!APPLICATION_SERVER_URL) {
        if (window.location.hostname === "localhost") {
            APPLICATION_SERVER_URL = "http://localhost:6080/";
        } else {
            APPLICATION_SERVER_URL = "https://" + window.location.hostname + ":6443/";
        }
    }

    if (!LIVEKIT_URL) {
        if (window.location.hostname === "localhost") {
            LIVEKIT_URL = "ws://localhost:7880/";
        } else {
            LIVEKIT_URL = "wss://" + window.location.hostname + ":7443/";
        }
    }
}

function App() {
    const [room, setRoom] = useState<Room | undefined>(undefined);
    const [localTrack, setLocalTrack] = useState<LocalVideoTrack | undefined>(undefined);
    const [remoteTracks, setRemoteTracks] = useState<TrackInfo[]>([]);
    const [participantName, setParticipantName] = useState("Participant" + Math.floor(Math.random() * 100));
    const [roomName, setRoomName] = useState("Test Room");
    const [messages, setMessages] = useState<string[]>([]);
    const [pendingMessages, setPendingMessages] = useState<{ [roomId: string]: { participantName: string; message: string } }>({});
    const [hasJoinedRoom, setHasJoinedRoom] = useState(false);
    const [websocket, setWebsocket] = useState<WebSocket | null>(null);
    const websocketRef = useRef<WebSocket | null>(null);

    useEffect(() => {
        if (room) {
            room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant, kind?: DataPacket_Kind, topic?: string) => {
                console.log('Data received:', { payload, participant, kind, topic });

                if (payload) {
                    try {
                        const strData = new TextDecoder().decode(payload);
                        console.log('Decoded data:', strData);

                        const data = JSON.parse(strData);
                        console.log('Parsed data:', data);

                        if (data.message && data.participantName) {
                            console.log('Received data from', data.participantName, data.message);
                            const roomId = room.name;
                            setMessages((prev) => [...prev, `Received from ${data.participantName}: ${data.message}`]);

                            if (!pendingMessages[roomId]) {
                                setPendingMessages(prev => ({
                                    ...prev,
                                    [roomId]: { participantName: data.participantName, message: data.message }
                                }));
                            }
                        } else {
                            console.log('Received data with missing message or participantName:', data);
                        }
                    } catch (e) {
                        console.error('Failed to parse received data:', e, 'Raw data:', strData);
                    }
                } else {
                    console.log('Received data with missing payload');
                }
            });

            room.on(RoomEvent.ConnectionStateChanged, (state) => {
                console.log(`Room connection state changed to: ${state}`);
            });
        }
    }, [room, pendingMessages]);

    useEffect(() => {
        const ws = new WebSocket(`${APPLICATION_SERVER_URL}ws`);
        setWebsocket(ws);
        websocketRef.current = ws;

        ws.onopen = () => {
            console.log('WebSocket Connected');
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'token') {
                joinRoomWithToken(data.token);
            }
        };

        return () => {
            ws.close();
        };
    }, []);

    const handleAccept = async (roomId: string, requestParticipantName: string) => {
        if (hasJoinedRoom) {
            console.log("Already joined a room. Ignoring accept request.");
            return;
        }

        try {
            const response = await fetch(`${APPLICATION_SERVER_URL}accept`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ roomName: roomId, requestParticipantName })
            });

            if (!response.ok) {
                console.log(response.text());
                throw new Error(`Failed to accept invitation: ${response.statusText}`);
            }

            const data = await response.json();
            const token = data.token;

            await sendTokenToParticipant(requestParticipantName, token);

            setPendingMessages({});

            await joinRoomWithToken(token);

        } catch (error) {
            console.error('Error accepting invitation:', error);
        }
    };

    async function sendTokenToParticipant(participantName: string, token: string) {
        try {
            const response = await fetch(`${APPLICATION_SERVER_URL}sendToken`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ participantName, token })
            });

            if (!response.ok) {
                console.log(response)
                console.error("Failed to send token to participant");
            }
        } catch (error) {
            console.error('Error sending token to participant:', error);
        }
    }

    async function joinRoomWithToken(token: string) {
        const room = new Room();
        setRoom(room);

        room.on(RoomEvent.TrackSubscribed, (_track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
            setRemoteTracks((prev) => [
                ...prev,
                { trackPublication: publication, participantIdentity: participant.identity }
            ]);
        });

        room.on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, publication: RemoteTrackPublication) => {
            setRemoteTracks((prev) => prev.filter((track) => track.trackPublication.trackSid !== publication.trackSid));
        });

        room.on(RoomEvent.ConnectionStateChanged, (state) => {
            console.log(`Room connection state changed to: ${state}`);
        });

        try {
            await room.connect(LIVEKIT_URL, token);
            await room.localParticipant.enableCameraAndMicrophone();
            setLocalTrack(room.localParticipant.videoTrackPublications.values().next().value.videoTrack);

            console.log('Successfully connected to the room');
            setHasJoinedRoom(true);
            setPendingMessages({});
        } catch (error) {
            console.log("There was an error connecting to the room:", (error as Error).message);
            await leaveRoom();
        }
    }

    const handleReject = async (roomId: string) => {
        try {
            const response = await fetch(`${APPLICATION_SERVER_URL}reject`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ roomName: roomId, participantName })
            });

            if (!response.ok) {
                throw new Error(`Failed to reject invitation: ${response.statusText}`);
            }

            setPendingMessages(prev => {
                const newPendingMessages = { ...prev };
                delete newPendingMessages[roomId];
                return newPendingMessages;
            });
        } catch (error) {
            console.error('Error rejecting invitation:', error);
        }
    };

    async function joinRoom() {
        const room = new Room();
        setRoom(room);

        room.on(RoomEvent.TrackSubscribed, (_track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
            setRemoteTracks((prev) => [
                ...prev,
                { trackPublication: publication, participantIdentity: participant.identity }
            ]);
        });

        room.on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, publication: RemoteTrackPublication) => {
            setRemoteTracks((prev) => prev.filter((track) => track.trackPublication.trackSid !== publication.trackSid));
        });

        try {
            const token = await getToken(roomName, participantName);
            await room.connect(LIVEKIT_URL, token);
            await room.localParticipant.enableCameraAndMicrophone();
            setLocalTrack(room.localParticipant.videoTrackPublications.values().next().value.videoTrack);
        } catch (error) {
            console.log("There was an error connecting to the room:", (error as Error).message);
            await leaveRoom();
        }
    }

    async function leaveRoom() {
        await room?.disconnect();
        setRoom(undefined);
        setLocalTrack(undefined);
        setRemoteTracks([]);
        setHasJoinedRoom(false); // Ensure this is reset when leaving the room
    }

    async function getToken(roomName: string, participantName: string) {
        const response = await fetch(APPLICATION_SERVER_URL + "token", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                roomName: roomName,
                participantName: participantName
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(`Failed to get token: ${error.errorMessage}`);
        }

        const data = await response.json();
        return data.token;
    }

    async function messageAllRooms(message: string, participantName: string) {
        console.log("message sent from " + participantName + ", message:" + message);
        const payload = JSON.stringify({ message, participantName });

        const response = await fetch(APPLICATION_SERVER_URL + "messageAllRooms", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: payload
        });

        if (!response.ok) {
            console.log("Failed to send message to all rooms");
        } else {
            if (websocketRef.current) {
                websocketRef.current.send(JSON.stringify({
                    type: 'participantInfo',
                    participantName: participantName
                }));
            }
        }
    }

    return (
        <>
            {!room ? (
                <div id="join">
                    <div id="join-dialog">
                        <h2>Join a Video Room</h2>
                        <form
                            onSubmit={(e) => {
                                joinRoom();
                                e.preventDefault();
                            }}
                        >
                            <div>
                                <label htmlFor="participant-name">Participant</label>
                                <input
                                    id="participant-name"
                                    className="form-control"
                                    type="text"
                                    value={participantName}
                                    onChange={(e) => setParticipantName(e.target.value)}
                                    required
                                />
                            </div>
                            <div>
                                <label htmlFor="room-name">Room</label>
                                <input
                                    id="room-name"
                                    className="form-control"
                                    type="text"
                                    value={roomName}
                                    onChange={(e) => setRoomName(e.target.value)}
                                    required
                                />
                            </div>
                            <button
                                className="btn btn-lg btn-success"
                                type="submit"
                                disabled={!roomName || !participantName}
                            >
                                Join!
                            </button>
                        </form>
                        <button
                            className="btn btn-lg btn-primary"
                            onClick={() => messageAllRooms("Hello everyone!", participantName)}
                        >
                            Send Message to All Rooms
                        </button>
                    </div>
                </div>
            ) : (
                <div id="room">
                    <div id="room-header">
                        <h2 id="room-title">{roomName}</h2>
                        <button className="btn btn-danger" id="leave-room-button" onClick={leaveRoom}>
                            Leave Room
                        </button>
                    </div>
                    <div id="layout-container">
                        {localTrack && (
                            <VideoComponent track={localTrack} participantIdentity={participantName} local={true} />
                        )}
                        {remoteTracks.map((remoteTrack) =>
                            remoteTrack.trackPublication.kind === "video" ? (
                                <VideoComponent
                                    key={remoteTrack.trackPublication.trackSid}
                                    track={remoteTrack.trackPublication.videoTrack!}
                                    participantIdentity={remoteTrack.participantIdentity}
                                />
                            ) : (
                                <AudioComponent
                                    key={remoteTrack.trackPublication.trackSid}
                                    track={remoteTrack.trackPublication.audioTrack!}
                                />
                            )
                        )}
                    </div>
                    {!hasJoinedRoom && Object.entries(pendingMessages).map(([roomId, { participantName, message }]) => (
                        <div key={roomId} className="message-buttons">
                            <p>{`Received a message from ${participantName}: ${message}`}</p>
                            <button onClick={() => handleAccept(roomId, participantName)}>Accept</button>
                            <button onClick={() => handleReject(roomId)}>Reject</button>
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}

export default App;
