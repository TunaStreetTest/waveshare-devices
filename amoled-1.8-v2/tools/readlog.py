import serial, time, sys
p = serial.Serial()
p.port = "COM8"
p.baudrate = 115200
p.timeout = 1
p.dtr = False
p.rts = False
p.open()
end = time.time() + 90
data = b""
while time.time() < end:
    data += p.read(4096)
p.close()
sys.stdout.write(data.decode(errors="replace"))
