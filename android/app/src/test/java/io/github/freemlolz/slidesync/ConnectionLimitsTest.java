package io.github.freemlolz.slidesync;

import java.io.IOException;
import java.nio.channels.SocketChannel;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.Test;
import static org.junit.Assert.*;

public class ConnectionLimitsTest {
    @Test public void shutdownRejectsLateConnectionsAndClosesTheirSockets() throws Exception {
        BoundedWebSocketFactory factory = new BoundedWebSocketFactory();
        factory.close();
        try (SocketChannel channel = SocketChannel.open()) {
            try { factory.wrapChannel(channel, null); fail("Connection accepted after shutdown"); }
            catch (IOException expected) { assertFalse(channel.isOpen()); }
        }
    }

    @Test public void ordinaryBrowserWebSocketsNeedNoNamedSubprotocolAndFramesStayBounded() {
        org.java_websocket.drafts.Draft_6455 draft = PresentationServer.viewerDraft();
        assertEquals(4096, draft.getMaxFrameSize());
        assertTrue(draft.getKnownProtocols().stream().anyMatch(protocol -> protocol.acceptProvidedProtocol("")));
    }

    @Test public void limitsPendingConnectionsAndClosesExcessSockets() throws Exception {
        BoundedWebSocketFactory factory = new BoundedWebSocketFactory(() -> 0);
        List<SocketChannel> accepted = new ArrayList<>();
        try {
            for (int index = 0; index < 64; index++) {
                SocketChannel channel = SocketChannel.open();
                accepted.add(channel);
                assertSame(channel, factory.wrapChannel(channel, null));
            }
            SocketChannel rejected = SocketChannel.open();
            try { factory.wrapChannel(rejected, null); fail("Accepted more than 64 pending sockets"); }
            catch (IOException expected) { assertFalse(rejected.isOpen()); }
            finally { rejected.close(); }
        } finally { factory.close(); }
        for (SocketChannel channel : accepted) assertFalse(channel.isOpen());
    }

    @Test public void incompleteHandshakesExpireAndClosedSlotsAreReusable() throws Exception {
        AtomicLong clock = new AtomicLong();
        BoundedWebSocketFactory factory = new BoundedWebSocketFactory(clock::get);
        SocketChannel channel = SocketChannel.open();
        try {
            factory.wrapChannel(channel, null);
            clock.set(7_000_000_000L);
            factory.sweep();
            assertTrue(channel.isOpen());
            clock.incrementAndGet();
            factory.sweep();
            assertFalse(channel.isOpen());
            SocketChannel replacement = SocketChannel.open();
            assertSame(replacement, factory.wrapChannel(replacement, null));
        } finally { factory.close(); channel.close(); }
    }
}
