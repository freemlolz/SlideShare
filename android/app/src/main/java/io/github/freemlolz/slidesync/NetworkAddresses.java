package io.github.freemlolz.slidesync;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class NetworkAddresses {
    private NetworkAddresses() {}

    public static List<String> list() {
        List<String> addresses = new ArrayList<>();
        try {
            for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!network.isUp() || network.isLoopback()) continue;
                for (InetAddress address : Collections.list(network.getInetAddresses())) {
                    if (address instanceof Inet4Address && !address.isLoopbackAddress() && !address.isLinkLocalAddress()) {
                        if (network.getName().startsWith("wlan") || network.getName().startsWith("ap")) addresses.add(0, address.getHostAddress());
                        else addresses.add(address.getHostAddress());
                    }
                }
            }
        } catch (Exception ignored) {}
        return addresses;
    }
}
