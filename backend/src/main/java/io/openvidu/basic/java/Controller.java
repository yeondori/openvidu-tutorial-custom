package io.openvidu.basic.java;

import io.livekit.server.*;
import livekit.LivekitModels;
import livekit.LivekitWebhook.WebhookEvent;
import org.json.JSONException;
import org.json.JSONObject;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import retrofit2.Call;
import retrofit2.Response;

import java.io.IOException;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@CrossOrigin(origins = "*")
@RestController
public class Controller {

    @Value("${livekit.api.key}")
    private String LIVEKIT_API_KEY;

    @Value("${livekit.api.secret}")
    private String LIVEKIT_API_SECRET;

    private final RoomServiceClient roomServiceClient;

    public Controller(@Value("${livekit.api.key}") String LIVEKIT_API_KEY,
                      @Value("${livekit.api.secret}") String LIVEKIT_API_SECRET) {
        this.LIVEKIT_API_KEY = LIVEKIT_API_KEY;
        this.LIVEKIT_API_SECRET = LIVEKIT_API_SECRET;
        this.roomServiceClient = RoomServiceClient.create("http://localhost:7880/", LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    }

    private final ConcurrentHashMap<String, WebSocketSession> sessionMap = new ConcurrentHashMap<>();

    // WebSocket 핸들러에서 호출될 메서드
    public void handleWebSocketMessage(WebSocketSession session, TextMessage message) {
        try {
            JSONObject jsonMessage = new JSONObject(message.getPayload());
            if ("participantInfo".equals(jsonMessage.getString("type"))) {
                String participantName = jsonMessage.getString("participantName");
                sessionMap.put(participantName, session);
            }
        } catch (JSONException e) {
            e.printStackTrace();
        }
    }

    @PostMapping("/messageAllRooms")
    public ResponseEntity<String> messageAllRooms(@RequestBody Map<String, String> params) {

        String message = params.get("message");
        String participantName = params.get("participantName");

        if (message == null || participantName == null) {
            return ResponseEntity.badRequest().body("Message and participantName are required");
        }

        System.out.println("Message: " + message);
        System.out.println("ParticipantName: " + participantName);

        try {
            Call<List<LivekitModels.Room>> roomListCall = roomServiceClient.listRooms();
            Response<List<LivekitModels.Room>> response = roomListCall.execute();

            if (!response.isSuccessful()) {
                return ResponseEntity.status(500).body("Failed to fetch rooms");
            }

            List<LivekitModels.Room> rooms = response.body();

            // 모든 방에 알림 전송
            for (LivekitModels.Room room : rooms) {
                LivekitModels.DataPacket.Kind kind = LivekitModels.DataPacket.Kind.RELIABLE;
                List<String> destinationIdentities = List.of(); // All participants

                String jsonPayload = "{\"message\": \"" + message + "\", \"participantName\": \"" + participantName + "\"}";
                Call<Void> call = roomServiceClient.sendData(room.getName(), jsonPayload.getBytes(), kind, destinationIdentities);
                Response<Void> sendResponse = call.execute();
                if (!sendResponse.isSuccessful()) {
                    System.err.println("Failed to send message to room: " + room.getName() + " with response: " + sendResponse.message());
                } else {
                    System.out.println("Message sent to room: " + room.getName());
                }
            }
            return ResponseEntity.ok("Message sent to all rooms");
        } catch (Exception e) {
            e.printStackTrace();
            return ResponseEntity.status(500).body("Failed to send message to all rooms");
        }
    }

    @PostMapping("/accept")
    public ResponseEntity<Map<String, String>> acceptInvitation(@RequestBody Map<String, String> params) {
        System.out.println("AcceptInvitation: " + params);
        String roomName = params.get("roomName");
        String participantName = params.get("requestParticipantName");

        if (roomName == null || participantName == null) {
            System.out.println("Missing roomName or participantName");
            return ResponseEntity.badRequest().body(Collections.singletonMap("error", "Missing roomName or participantName"));
        }

        WebSocketSession session = sessionMap.get(participantName);
        if (session == null || !session.isOpen()) {
            return ResponseEntity.status(404).body(Collections.singletonMap("error", "Session not found or closed"));
        }

        // 이미 토큰을 발급받은 참가자인지 확인
        if (session.getAttributes().containsKey("tokenIssued")) {
            return ResponseEntity.status(400).body(Collections.singletonMap("error", "Token already issued for this participant"));
        }

        // 승인받은 방 제목으로 토큰 생성
        AccessToken token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
        token.setName(roomName);
        token.setIdentity(participantName);
        token.addGrants(new RoomJoin(true), new RoomName(roomName));

        // 토큰 발급 표시
        session.getAttributes().put("tokenIssued", true);
        System.out.println("[AcceptInvitation] 토큰 발급 roomName: " + roomName + " participantName: " + participantName);
        return ResponseEntity.ok(Map.of("token", token.toJwt()));
    }

    @PostMapping("/reject")
    public ResponseEntity<String> rejectInvitation(@RequestBody Map<String, String> params) {
        String roomName = params.get("roomName");
        String participantName = params.get("participantName");

        if (roomName == null || participantName == null) {
            return ResponseEntity.badRequest().body("Missing roomName or participantName");
        }

        // Perform actions needed to reject the invitation
        return ResponseEntity.ok("Invitation rejected for room: " + roomName);
    }

    @PostMapping("/sendToken")
    public ResponseEntity<String> sendToken(@RequestBody Map<String, String> params) {
        String participantName = params.get("participantName");
        String token = params.get("token");

        if (participantName == null || token == null) {
            return ResponseEntity.badRequest().body("ParticipantName and token are required");
        }

        WebSocketSession session = sessionMap.get(participantName);
        System.out.println("[sendToken] session: " + session);
        if (session != null && session.isOpen()) {

            try {
                JSONObject jsonMessage = new JSONObject();
                jsonMessage.put("type", "token");
                jsonMessage.put("token", token);
                session.sendMessage(new TextMessage(jsonMessage.toString()));

                System.out.println("토큰 전송 성공!");
                return ResponseEntity.ok("Token sent");
            } catch (IOException | JSONException e) {
                e.printStackTrace();
                return ResponseEntity.status(500).body("Failed to send token");
            }
        } else {
            return ResponseEntity.status(404).body("Session not found or closed");
        }
    }

    @PostMapping("/token")
    public ResponseEntity<Map<String, String>> createToken(@RequestBody Map<String, String> params) {
        String roomName = params.get("roomName");
        String participantName = params.get("participantName");

        if (roomName == null || participantName == null) {
            return ResponseEntity.badRequest().body(Map.of("errorMessage", "roomName and participantName are required"));
        }

        AccessToken token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
        token.setName(participantName);
        token.setIdentity(participantName);
        token.addGrants(new RoomJoin(true), new RoomName(roomName));

        return ResponseEntity.ok(Map.of("token", token.toJwt()));
    }

    @PostMapping(value = "/livekit/webhook", consumes = "application/webhook+json")
    public ResponseEntity<String> receiveWebhook(@RequestHeader("Authorization") String authHeader, @RequestBody String body) {
        WebhookReceiver webhookReceiver = new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
        try {
            WebhookEvent event = webhookReceiver.receive(body, authHeader);
            System.out.println("LiveKit Webhook: " + event.toString());
        } catch (Exception e) {
            System.err.println("Error validating webhook event: " + e.getMessage());
        }
        return ResponseEntity.ok("ok");
    }
}
