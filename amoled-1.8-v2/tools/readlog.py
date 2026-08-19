"""Attach to a running board WITHOUT resetting and capture serial.
Usage: python readlog.py [PORT] [SECONDS] -- defaults COM8, 90 s.
Note: a fresh USB-Serial/JTAG attach often reads 0 bytes until the next
reset; if you get nothing, use bootlog.py instead."""
import serial, sys, time

port = sys.argv[1] if len(sys.argv) > 1 else "COM8"
secs = float(sys.argv[2]) if len(sys.argv) > 2 else 90
p = serial.Serial()
p.port = port
p.baudrate = 115200
p.timeout = 1
p.dtr = False
p.rts = False
p.open()
end = time.time() + secs
data = b""
while time.time() < end:
    data += p.read(4096)
p.close()
sys.stdout.write(data.decode(errors="replace"))
