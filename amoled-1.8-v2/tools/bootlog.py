import serial, time, sys
p = serial.Serial()
p.port = "COM8"
p.baudrate = 115200
p.timeout = 1
p.dtr = False
p.rts = False
p.open()
# Reset the chip: RTS -> EN (active low), DTR low keeps IO0 high (normal boot)
p.rts = True
time.sleep(0.1)
p.rts = False
end = time.time() + 30
data = b""
while time.time() < end:
    data += p.read(4096)
p.close()
sys.stdout.write(data.decode(errors="replace"))
