FROM node:20-slim

RUN apt-get update && apt-get install -y \
    libreoffice \
    libreoffice-writer \
    libreoffice-impress \
    libreoffice-calc \
    fonts-noto-cjk \
    fonts-noto-cjk-extra \
    python3 \
    build-essential \
    tesseract-ocr \
    tesseract-ocr-chi-tra \
    tesseract-ocr-chi-sim \
    tesseract-ocr-eng \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# LibreOffice headless needs a display or fake one
ENV DISPLAY=:99

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN mkdir -p uploads outputs data/db

EXPOSE 3005

CMD ["node", "server.js"]
