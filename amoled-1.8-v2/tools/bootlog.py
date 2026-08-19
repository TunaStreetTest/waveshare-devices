"""Reset the board and capture boot serial. Usage: python bootlog.py [PORT] [SECONDS]
Defaults: COM8 (WindowsDesktop), 30 s. On StarlinkAI the board enumerates as COM6."""
import serial, sys, time

port = sys.argv[1] if len(sys.argv) > 1 else "COM8"
secs = float(sys.argv[2]) if len(sys.argv) > 2 else 30
p = serial.Serial()
p.port = port
p.baudrate = 115200
p.timeout = 1
p.dtr = False
p.rts = False
p.open()
# Reset the chip: RTS -> EN (active low), DTR low keeps IO0 high (normal boot)
p.rts = True
time.sleep(0.1)
p.rts = False
end = time.time() + secs
data = b""
while time.time() < end:
    data += p.read(4096)
p.close()
sys.stdout.write(data.decode(errors="replace"))
