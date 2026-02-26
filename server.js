// server.js
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 }); // Server runs on port 8080

const clients = new Map(); // Map<WebSocket, { id: string }>
const streamers = new Map(); // Map<string, { ws: WebSocket, concertId: string, id: string }> (key is streamerId)
const concertViewers = new Map(); // Map<string, Set<WebSocket>> (key is concertId)

console.log('Signaling server started on port 8080');

function broadcast(message, senderWs = null, targetConcertId = null) {
    const messageString = JSON.stringify(message);
    console.log(`Broadcasting (concert: ${targetConcertId || 'all'}): ${messageString.substring(0, 100)}...`);

    clients.forEach((clientData, ws) => {
        if (ws !== senderWs && ws.readyState === WebSocket.OPEN) {
            // If targetConcertId is specified, only send to viewers of that concert
            if (targetConcertId) {
                const viewers = concertViewers.get(targetConcertId);
                if (viewers && viewers.has(ws)) {
                    ws.send(messageString);
                }
            } else {
                // Broadcast to all if no target concert (e.g., potentially for global admin messages later)
                // For now, restrict broadcasts mainly by concert
            }
        }
    });
    // Specific broadcast for streamers list updates to relevant viewers
    if (message.type === 'new_streamer' || message.type === 'streamer_left') {
        const viewers = concertViewers.get(message.payload.concertId);
        if (viewers) {
            viewers.forEach(ws => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(messageString);
                }
            });
        }
    }
}


wss.on('connection', (ws) => {
    const clientId = `user_${Math.random().toString(36).substring(2, 9)}`;
    clients.set(ws, { id: clientId });
    console.log(`Client connected: ${clientId}`);

    // Send the client its ID
    ws.send(JSON.stringify({ type: 'assign_id', payload: { id: clientId } }));

    ws.on('message', (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
            // console.log(`Received from ${clientId}:`, parsedMessage);
            console.log(`Received from ${clientId}: type=${parsedMessage.type}`);


            switch (parsedMessage.type) {
                case 'announce_stream': { // Admin starts streaming
                    const { concertId } = parsedMessage.payload;
                    streamers.set(clientId, { ws, concertId, id: clientId });
                    clients.get(ws).isStreaming = true;
                    clients.get(ws).concertId = concertId;
                    console.log(`Admin ${clientId} started streaming for concert ${concertId}`);
                    broadcast({
                        type: 'new_streamer',
                        payload: { streamerId: clientId, concertId }
                    }, ws, concertId); // Broadcast to viewers of this concert
                    break;
                }
                case 'stop_stream': { // Admin stops streaming
                    const streamerData = streamers.get(clientId);
                    if (streamerData) {
                        const { concertId } = streamerData;
                        console.log(`Admin ${clientId} stopped streaming for concert ${concertId}`);
                        streamers.delete(clientId);
                        if (clients.has(ws)) {
                            clients.get(ws).isStreaming = false;
                            clients.get(ws).concertId = undefined;
                        }
                        broadcast({
                            type: 'streamer_left',
                            payload: { streamerId: clientId, concertId }
                        }, ws, concertId); // Broadcast to viewers of this concert
                    }
                    break;
                }
                case 'watch_concert': { // User wants to watch
                    const { concertId } = parsedMessage.payload;
                    if (!concertViewers.has(concertId)) {
                        concertViewers.set(concertId, new Set());
                    }
                    concertViewers.get(concertId).add(ws);
                    clients.get(ws).watchingConcertId = concertId;
                    console.log(`Client ${clientId} started watching concert ${concertId}`);

                    // Send current list of streamers for this concert
                    const currentStreamers = [];
                    streamers.forEach((streamer) => {
                        if (streamer.concertId === concertId) {
                            currentStreamers.push(streamer.id);
                        }
                    });
                    ws.send(JSON.stringify({
                        type: 'streamer_list',
                        payload: { concertId, streamerIds: currentStreamers }
                    }));
                    break;
                }
                case 'stop_watching': { // User leaves view page
                    const watchingConcertId = clients.get(ws)?.watchingConcertId;
                    if (watchingConcertId && concertViewers.has(watchingConcertId)) {
                        concertViewers.get(watchingConcertId).delete(ws);
                        if (concertViewers.get(watchingConcertId).size === 0) {
                            concertViewers.delete(watchingConcertId); // Clean up if no viewers left
                        }
                        console.log(`Client ${clientId} stopped watching concert ${watchingConcertId}`);
                    }
                    clients.get(ws).watchingConcertId = undefined;
                    break;
                }
                // --- WebRTC Signaling Messages ---
                case 'offer':
                case 'answer':
                case 'candidate': {
                    const targetId = parsedMessage.payload.targetId;
                    let targetWs = null;
                    // Find the target WebSocket connection
                    clients.forEach((data, clientWs) => {
                        if (data.id === targetId) {
                            targetWs = clientWs;
                        }
                    });

                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        // Add sender ID to the payload before relaying
                        const relayedPayload = { ...parsedMessage.payload, senderId: clientId };
                        console.log(`Relaying ${parsedMessage.type} from ${clientId} to ${targetId}`);
                        targetWs.send(JSON.stringify({
                            type: parsedMessage.type,
                            payload: relayedPayload
                        }));
                    } else {
                        console.log(`Target client ${targetId} not found or not open for ${parsedMessage.type}`);
                    }
                    break;
                }
                default:
                    console.log(`Unknown message type from ${clientId}: ${parsedMessage.type}`);
            }
        } catch (error) {
            console.error(`Failed to parse message from ${clientId} or handle:`, message, error);
        }
    });

    ws.on('close', () => {
        const clientData = clients.get(ws);
        const closedClientId = clientData?.id || 'unknown';
        console.log(`Client disconnected: ${closedClientId}`);

        // If the client was a streamer, notify viewers
        const streamerData = streamers.get(closedClientId);
        if (streamerData) {
            const { concertId } = streamerData;
            streamers.delete(closedClientId);
            broadcast({
                type: 'streamer_left',
                payload: { streamerId: closedClientId, concertId }
            }, ws, concertId);
        }
        // Remove from viewers list
        const watchingConcertId = clientData?.watchingConcertId;
        if (watchingConcertId && concertViewers.has(watchingConcertId)) {
            concertViewers.get(watchingConcertId).delete(ws);
            if (concertViewers.get(watchingConcertId).size === 0) {
                concertViewers.delete(watchingConcertId); // Clean up if no viewers left
            }
        }

        clients.delete(ws);
    });

    ws.on('error', (error) => {
        const clientId = clients.get(ws)?.id || 'unknown';
        console.error(`WebSocket error for client ${clientId}:`, error);
        // Clean up on error as well
        const streamerData = streamers.get(clientId);
        if (streamerData) {
            const { concertId } = streamerData;
            streamers.delete(clientId);
            broadcast({
                type: 'streamer_left',
                payload: { streamerId: clientId, concertId }
            }, ws, concertId);
        }
        const watchingConcertId = clients.get(ws)?.watchingConcertId;
        if (watchingConcertId && concertViewers.has(watchingConcertId)) {
            concertViewers.get(watchingConcertId).delete(ws);
        }
        clients.delete(ws);
    });
});