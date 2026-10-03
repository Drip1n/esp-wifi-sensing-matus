import serial
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.animation as animation

PORT = 'COM5'
BAUD = 115200

try:
    ser = serial.Serial(PORT, BAUD, timeout=0.1)
    print(f"Pripojene na {PORT}. Radar bezi!")
except Exception as e:
    print(f"Chyba: {e}")
    exit()

NUM_SUBCARRIERS = 64
HISTORY_LEN = 100
csi_matrix = np.zeros((NUM_SUBCARRIERS, HISTORY_LEN))

fig, ax = plt.subplots(figsize=(10, 6))
im = ax.imshow(csi_matrix, cmap='viridis', aspect='auto', interpolation='nearest', vmin=0, vmax=30)
ax.set_title("Wi-Fi Radar (Pohyb rozkmita vlny)")
ax.set_xlabel("Cas")
ax.set_ylabel("Frekvencie")
plt.colorbar(im, ax=ax, label="Sila")

def update(frame):
    global csi_matrix
    while ser.in_waiting:
        line = ser.readline().decode('utf-8', errors='ignore').strip()
        if line.startswith("CSI_DATA"):
            parts = line.split(',')
            if len(parts) > 3:
                try:
                    raw_bytes = np.array([int(p) for p in parts[3:]], dtype=np.int8)
                    limit = min(len(raw_bytes) // 2, NUM_SUBCARRIERS)
                    if limit > 0:
                        i_vals = raw_bytes[0:limit*2:2]
                        q_vals = raw_bytes[1:limit*2:2]
                        amplitudes = np.sqrt(i_vals**2 + q_vals**2)
                        csi_matrix = np.roll(csi_matrix, -1, axis=1)
                        csi_matrix[:len(amplitudes), -1] = amplitudes
                except ValueError:
                    pass
    im.set_data(csi_matrix)
    return [im]

ani = animation.FuncAnimation(fig, update, interval=40, blit=True)
plt.show()
ser.close()