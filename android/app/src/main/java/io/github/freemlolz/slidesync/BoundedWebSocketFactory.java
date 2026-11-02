package io.github.freemlolz.slidesync;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.SelectionKey;
import java.nio.channels.SocketChannel;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.java_websocket.WebSocket;
import org.java_websocket.WebSocketAdapter;
import org.java_websocket.WebSocketImpl;
import org.java_websocket.drafts.Draft;
import org.java_websocket.WebSocketServerFactory;

public final class BoundedWebSocketFactory implements WebSocketServerFactory {
    private final Map<SocketChannel, Long> channels = new ConcurrentHashMap<>();
    private final Set<SocketChannel> established = ConcurrentHashMap.newKeySet();
    private final java.util.function.LongSupplier now;
    private boolean closed;

    public BoundedWebSocketFactory() { this(System::nanoTime); }
    BoundedWebSocketFactory(java.util.function.LongSupplier now) { this.now = now; }

    private static final class BoundedSocket extends WebSocketImpl {
        private int handshakeBytes;
        BoundedSocket(WebSocketAdapter listener, List<Draft> drafts) { super(listener, drafts); }
        BoundedSocket(WebSocketAdapter listener, Draft draft) { super(listener, draft); }
        @Override public void decode(ByteBuffer input) {
            if (!isOpen()) {
                handshakeBytes += input.remaining();
                if (handshakeBytes > 8192) { closeConnection(1009, "Handshake too large"); return; }
            }
            super.decode(input);
        }
    }
    @Override public WebSocketImpl createWebSocket(WebSocketAdapter listener, List<Draft> drafts) { return new BoundedSocket(listener, drafts); }
    @Override public WebSocketImpl createWebSocket(WebSocketAdapter listener, Draft draft) { return new BoundedSocket(listener, draft); }
    @Override public synchronized SocketChannel wrapChannel(SocketChannel channel, SelectionKey key) throws IOException {
        sweep();
        if (closed || channels.size() >= 64) { channel.close(); throw new IOException("Server closed or connection limit reached"); }
        channels.put(channel, now.getAsLong());
        return channel;
    }
    public synchronized void opened(WebSocket connection) {
        SocketChannel channel = (SocketChannel) ((WebSocketImpl) connection).getChannel();
        if (!closed && channel.isOpen()) established.add(channel);
    }
    public void sweep() {
        long time = now.getAsLong();
        for (Map.Entry<SocketChannel, Long> entry : channels.entrySet()) {
            SocketChannel channel = entry.getKey();
            if (!channel.isOpen() || (!established.contains(channel) && time - entry.getValue() > 7_000_000_000L)) {
                try { channel.close(); } catch (IOException ignored) {}
                established.remove(channel);
                channels.remove(channel);
            }
        }
    }
    @Override public synchronized void close() {
        closed = true;
        for (SocketChannel channel : channels.keySet()) try { channel.close(); } catch (IOException ignored) {}
        channels.clear(); established.clear();
    }
}
