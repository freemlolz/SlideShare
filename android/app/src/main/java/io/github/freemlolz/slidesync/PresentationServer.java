package io.github.freemlolz.slidesync;

import android.content.res.AssetManager;
import android.net.Uri;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import fi.iki.elonen.NanoHTTPD;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.java_websocket.WebSocket;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.exceptions.InvalidDataException;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.handshake.ServerHandshakeBuilder;
import org.java_websocket.server.WebSocketServer;

public final class PresentationServer implements AutoCloseable {
    private static final Set<String> ASSETS = new HashSet<>(Arrays.asList("viewer.js", "sync.js", "slides.js", "annotations.js", "polls.js", "polls.css", "style.css", "api.js"));
    private final PdfDeck deck;
    private final AssetManager assets;
    private final String token = secret();
    private final String sessionId = secret().substring(0, 24);
    private final Map<WebSocket, Integer> viewers = new ConcurrentHashMap<>();
    private final ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor();
    private final Set<NanoHTTPD.ClientHandler> httpClients = ConcurrentHashMap.newKeySet();
    private final ThreadPoolExecutor httpPool = new ThreadPoolExecutor(16, 16, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(32));
    private final BoundedWebSocketFactory socketFactory = new BoundedWebSocketFactory();
    private NanoHTTPD http;
    private WebSocketServer sockets;
    private volatile boolean closed;
    private int slide;
    private long revision;

    public PresentationServer(AssetManager assets, PdfDeck deck) { this.assets = assets; this.deck = deck; }
    static Draft_6455 viewerDraft() { return new Draft_6455(Collections.emptyList(), 4096); }

    public void start() throws IOException {
        http = new NanoHTTPD("0.0.0.0", 0) {
            @Override public Response serve(IHTTPSession request) { return serveHttp(request); }
        };
        http.setAsyncRunner(new NanoHTTPD.AsyncRunner() {
            @Override public void exec(NanoHTTPD.ClientHandler client) {
                httpClients.add(client);
                try { httpPool.execute(client); }
                catch (java.util.concurrent.RejectedExecutionException error) { client.close(); httpClients.remove(client); }
            }
            @Override public void closed(NanoHTTPD.ClientHandler client) { httpClients.remove(client); }
            @Override public void closeAll() { for (NanoHTTPD.ClientHandler client : httpClients) client.close(); httpClients.clear(); }
        });
        http.start(10_000, true);
        CountDownLatch ready = new CountDownLatch(1);
        IOException[] failure = new IOException[1];
        sockets = new WebSocketServer(new InetSocketAddress("0.0.0.0", 0), 2,
                Collections.singletonList(viewerDraft())) {
            @Override public void onStart() { ready.countDown(); }
            @Override public ServerHandshakeBuilder onWebsocketHandshakeReceivedAsServer(WebSocket connection, org.java_websocket.drafts.Draft draft, ClientHandshake request) throws InvalidDataException {
                Uri resource = Uri.parse(request.getResourceDescriptor());
                String origin = request.getFieldValue("Origin");
                if (!"/ws".equals(resource.getPath()) || !validToken(resource.getQueryParameter("token"))
                        || !"viewer".equals(resource.getQueryParameter("role")) || !validOrigin(origin)
                        || viewers.size() >= 64) throw new InvalidDataException(1008, "Недозволене підключення.");
                return super.onWebsocketHandshakeReceivedAsServer(connection, draft, request);
            }
            @Override public void onOpen(WebSocket connection, ClientHandshake request) {
                socketFactory.opened(connection);
                if (closed || viewers.size() >= 64) { connection.close(1008); return; }
                viewers.put(connection, 0);
                publish();
            }
            @Override public void onClose(WebSocket connection, int code, String reason, boolean remote) { viewers.remove(connection); if (!closed) publish(); }
            @Override public void onMessage(WebSocket connection, String message) {
                try {
                    JSONObject report = new JSONObject(message);
                    int loaded = report.optInt("loaded", -1);
                    if ("ready".equals(report.optString("type")) && deck.id.equals(report.optString("deckId"))
                            && loaded >= 0 && loaded <= deck.pages.size()) {
                        Integer previous = viewers.replace(connection, loaded);
                        if (previous != null && previous != loaded) publish();
                    }
                } catch (JSONException ignored) { connection.close(1008); }
            }
            @Override public void onMessage(WebSocket connection, ByteBuffer message) { connection.close(1003); }
            @Override public void onError(WebSocket connection, Exception error) {
                if (connection == null) { failure[0] = new IOException("Не вдалося запустити WebSocket.", error); ready.countDown(); }
            }
        };
        sockets.setConnectionLostTimeout(20);
        sockets.setWebSocketFactory(socketFactory);
        sockets.setReuseAddr(true);
        sockets.start();
        try {
            if (!ready.await(8, TimeUnit.SECONDS)) throw new IOException("Сервер запускається надто довго.");
            if (failure[0] != null) throw failure[0];
        } catch (InterruptedException error) { Thread.currentThread().interrupt(); close(); throw new IOException("Запуск скасовано."); }
        catch (IOException error) { close(); throw error; }
        heartbeat.scheduleWithFixedDelay(this::sendState, 5, 5, TimeUnit.SECONDS);
        heartbeat.scheduleWithFixedDelay(socketFactory::sweep, 1, 1, TimeUnit.SECONDS);
    }

    public int port() { return http.getListeningPort(); }
    public int websocketPort() { return sockets.getPort(); }
    public String joinUrl(String address) { return "http://" + address + ":" + port() + "/join#token=" + token; }
    public synchronized int currentSlide() { return slide; }
    public int participants() { return viewers.size(); }
    public int readyCount() { int count = 0; for (int loaded : viewers.values()) if (loaded == deck.pages.size()) count++; return count; }
    public PdfDeck deck() { return deck; }

    public synchronized void setSlide(int index) {
        if (index < 0 || index >= deck.pages.size() || index == slide || closed) return;
        slide = index;
        publish();
    }

    private synchronized JSONObject state() throws JSONException {
        return new JSONObject().put("type", "state").put("sessionId", sessionId).put("revision", revision)
                .put("serverTime", System.currentTimeMillis()).put("slide", slide).put("deck", deck.json())
                .put("processing", JSONObject.NULL).put("poll", JSONObject.NULL)
                .put("annotations", new JSONObject().put("epoch", slide).put("strokes", new JSONArray()))
                .put("participants", participants()).put("ready", readyCount()).put("websocketPort", websocketPort());
    }

    private synchronized void publish() { revision++; sendState(); }
    private void sendState() {
        if (closed) return;
        try {
            String serialized = state().toString();
            for (WebSocket connection : viewers.keySet()) {
                if (connection.hasBufferedData()) continue;
                else try { connection.send(serialized); } catch (RuntimeException ignored) { connection.close(); }
            }
        } catch (JSONException ignored) {}
    }

    private NanoHTTPD.Response serveHttp(NanoHTTPD.IHTTPSession request) {
        String host = request.getHeaders().get("host");
        String origin = request.getHeaders().get("origin");
        if (!validHost(host, port()) || (origin != null && !origin.equals("http://" + host))) return jsonError(NanoHTTPD.Response.Status.FORBIDDEN, "Недозволене джерело.");
        String route = request.getUri();
        try {
            if (route.startsWith("/api/host") || "/host".equals(route)) return jsonError(NanoHTTPD.Response.Status.FORBIDDEN, "Керування доступне лише в застосунку ведучого.");
            if (request.getMethod() == NanoHTTPD.Method.GET && ("/".equals(route) || "/join".equals(route))) return asset("viewer.html", "text/html; charset=utf-8");
            if (request.getMethod() == NanoHTTPD.Method.GET && route.startsWith("/assets/") && ASSETS.contains(route.substring(8))) {
                String name = route.substring(8);
                return asset(name, name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
            }
            if (!validToken(request.getParms().get("token"))) return jsonError(NanoHTTPD.Response.Status.UNAUTHORIZED, "Сесію не знайдено. Відскануйте актуальний QR-код.");
            if (request.getMethod() == NanoHTTPD.Method.GET && "/api/state".equals(route)) return json(state());
            if (request.getMethod() == NanoHTTPD.Method.POST && "/api/ready".equals(route)) {
                int length = Integer.parseInt(request.getHeaders().getOrDefault("content-length", "0"));
                if (length < 1 || length > 2048) return jsonError(NanoHTTPD.Response.Status.BAD_REQUEST, "Некоректний звіт готовності.");
                Map<String, String> body = new HashMap<>();
                request.parseBody(body);
                JSONObject report = new JSONObject(body.getOrDefault("postData", "{}"));
                int loaded = report.optInt("loaded", -1);
                if (!deck.id.equals(report.optString("deckId")) || loaded < 0 || loaded > deck.pages.size()) return jsonError(NanoHTTPD.Response.Status.BAD_REQUEST, "Некоректна готовність слайдів.");
                return json(new JSONObject().put("ok", true));
            }
            String prefix = "/slides/" + deck.id + "/";
            if (request.getMethod() == NanoHTTPD.Method.GET && route.startsWith(prefix) && route.substring(prefix.length()).matches("[1-9][0-9]{0,2}\\.jpg")) {
                int index = Integer.parseInt(route.substring(prefix.length(), route.length() - 4)) - 1;
                if (index < 0 || index >= deck.pages.size()) return jsonError(NanoHTTPD.Response.Status.NOT_FOUND, "Слайд не знайдено.");
                File file = deck.slide(index);
                return secure(NanoHTTPD.newFixedLengthResponse(NanoHTTPD.Response.Status.OK, "image/jpeg", new FileInputStream(file), file.length()));
            }
            return jsonError(NanoHTTPD.Response.Status.NOT_FOUND, "Ця можливість ще недоступна в Android Beta.");
        } catch (Exception error) { return jsonError(NanoHTTPD.Response.Status.BAD_REQUEST, "Не вдалося обробити запит."); }
    }

    private NanoHTTPD.Response asset(String name, String mime) throws IOException { return secure(NanoHTTPD.newChunkedResponse(NanoHTTPD.Response.Status.OK, mime, assets.open("web/" + name))); }
    private NanoHTTPD.Response json(JSONObject value) { return secure(NanoHTTPD.newFixedLengthResponse(NanoHTTPD.Response.Status.OK, "application/json; charset=utf-8", value.toString())); }
    private NanoHTTPD.Response jsonError(NanoHTTPD.Response.Status status, String message) {
        try { return secure(NanoHTTPD.newFixedLengthResponse(status, "application/json; charset=utf-8", new JSONObject().put("error", message).toString())); }
        catch (JSONException error) { throw new IllegalStateException(error); }
    }
    private NanoHTTPD.Response secure(NanoHTTPD.Response response) {
        response.addHeader("Cache-Control", "no-store");
        response.addHeader("X-Content-Type-Options", "nosniff");
        response.addHeader("Referrer-Policy", "no-referrer");
        response.addHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' ws:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        response.closeConnection(true);
        return response;
    }
    private boolean validToken(String actual) { return actual != null && MessageDigest.isEqual(actual.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8)); }
    private boolean validOrigin(String origin) {
        if (origin == null || origin.isEmpty()) return false;
        Uri url = Uri.parse(origin);
        return "http".equals(url.getScheme()) && url.getPort() == port() && validHost(url.getHost() + ":" + url.getPort(), port())
                && (url.getPath() == null || url.getPath().isEmpty()) && url.getQuery() == null && url.getFragment() == null && url.getUserInfo() == null;
    }
    private boolean validHost(String host, int port) {
        if (host == null) return false;
        if (host.equals("127.0.0.1:" + port) || host.equals("localhost:" + port)) return true;
        for (String address : NetworkAddresses.list()) if (host.equals(address + ":" + port)) return true;
        return false;
    }
    private static String secret() {
        byte[] random = new byte[24]; new SecureRandom().nextBytes(random);
        StringBuilder result = new StringBuilder(); for (byte value : random) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255)); return result.toString();
    }
    @Override public void close() {
        closed = true;
        heartbeat.shutdownNow();
        socketFactory.close();
        if (http != null) http.stop();
        httpPool.shutdownNow();
        if (sockets != null) try { sockets.stop(1000); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        viewers.clear();
    }
}
