
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

// Make LameJS available in the component
declare const lamejs: any;

interface AudioChunk {
  fileName: string;
  url: string;
}

const MAX_FILE_SIZE_MB = 100;

const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number>(60);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [chunks, setChunks] = useState<AudioChunk[]>([]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = (e.target as HTMLInputElement).files?.[0];
    if (selectedFile) {
      const fileName = selectedFile.name.toLowerCase();
      const fileType = selectedFile.type.toLowerCase();
      const fileSizeMB = selectedFile.size / (1024 * 1024);

      if (fileSizeMB > MAX_FILE_SIZE_MB) {
        setError(`File is too large (${fileSizeMB.toFixed(2)} MB). Maximum supported size is ${MAX_FILE_SIZE_MB} MB to prevent browser memory issues.`);
        setFile(null);
        return;
      }
      
      // Extensive check for AAC/M4A and other audio formats
      const isAacOrM4a = 
        fileType.includes('aac') || 
        fileType.includes('m4a') || 
        fileType.includes('mp4') ||
        fileType.includes('mpeg') ||
        /\.(aac|m4a|mp4|m4b|m4p)$/i.test(fileName);

      const isValidAudio = 
        fileType.startsWith('audio/') || 
        isAacOrM4a ||
        /\.(mp3|wav|ogg|flac|webm)$/i.test(fileName);

      if (isValidAudio) {
        setFile(selectedFile);
        setChunks([]);
        setError('');
      } else {
        setError('Unsupported format. Please select an AAC, M4A, MP3, or WAV file.');
        setFile(null);
      }
    }
  };

  const processAudio = async () => {
    if (!file) {
      setError('No file selected.');
      return;
    }
    if (duration <= 0) {
      setError('Chunk duration must be greater than 0.');
      return;
    }

    setIsLoading(true);
    setChunks([]);
    setError('');
    setStatusMessage('Preparing memory for large file...');

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    // Lower sample rate can help with memory if it was a bottleneck, 
    // but decodeAudioData usually returns the source rate.
    const audioContext = new AudioContextClass();
    
    try {
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      setStatusMessage('Reading file buffer (this may take a moment for 100MB files)...');
      const arrayBuffer = await file.arrayBuffer();

      setStatusMessage('Decoding audio stream... Large files require significant RAM.');
      
      // Attempt to decode. 100MB compressed AAC can be 1GB+ in RAM as PCM.
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer).catch(err => {
        let extraInfo = '';
        if (file.size > 50 * 1024 * 1024) {
          extraInfo = ' Large files may exceed browser memory limits. Try a shorter file or a different browser.';
        }
        throw new Error(`The browser could not decode this file.${extraInfo} Details: ${err.message || 'Unknown error'}`);
      });

      const { numberOfChannels, sampleRate, length } = audioBuffer;
      const chunkLength = sampleRate * duration;
      const numChunks = Math.ceil(length / chunkLength);
      const generatedChunks: AudioChunk[] = [];
      const originalFileName = file.name.replace(/\.[^/.]+$/, '');

      for (let i = 0; i < numChunks; i++) {
        setStatusMessage(`Extracting part ${i + 1} of ${numChunks}...`);
        
        const start = i * chunkLength;
        const end = Math.min(start + chunkLength, length);
        const frameCount = end - start;

        if (frameCount <= 0) continue;

        const chunkBuffer = audioContext.createBuffer(
          numberOfChannels,
          frameCount,
          sampleRate
        );

        for (let channel = 0; channel < numberOfChannels; channel++) {
          const sourceData = audioBuffer.getChannelData(channel);
          const chunkData = chunkBuffer.getChannelData(channel);
          chunkData.set(sourceData.subarray(start, end));
        }
        
        setStatusMessage(`Converting part ${i + 1} to MP3...`);
        
        // Give the UI thread a chance to breathe
        await new Promise(resolve => setTimeout(resolve, 50));
        
        const mp3Blob = encodeToMp3(chunkBuffer);
        const url = URL.createObjectURL(mp3Blob);
        const fileName = `${originalFileName}-part${i + 1}.mp3`;
        generatedChunks.push({ fileName, url });
      }

      setChunks(generatedChunks);
      setStatusMessage('Splitting complete!');
    } catch (err) {
      console.error('Audio processing failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Error: ${msg}`);
    } finally {
      setIsLoading(false);
      if (audioContext.state !== 'closed') {
        audioContext.close();
      }
    }
  };

  const encodeToMp3 = (audioBuffer: AudioBuffer): Blob => {
    const channels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const useChannels = Math.min(channels, 2);
    
    // LameJS encoder: Stereo or Mono
    const mp3encoder = new lamejs.Mp3Encoder(useChannels, sampleRate, 128);
    
    // Convert Float32 PCM to Int16 PCM for LameJS
    const leftSamples = audioBuffer.getChannelData(0);
    const leftData = new Int16Array(leftSamples.length);
    for (let i = 0; i < leftSamples.length; i++) {
      const s = Math.max(-1, Math.min(1, leftSamples[i]));
      leftData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    let rightData: Int16Array | undefined;
    if (useChannels === 2) {
      const rightSamples = audioBuffer.getChannelData(1);
      rightData = new Int16Array(rightSamples.length);
      for (let i = 0; i < rightSamples.length; i++) {
        const s = Math.max(-1, Math.min(1, rightSamples[i]));
        rightData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
    }

    const mp3Data = [];
    const bufferSize = 1152;
    
    for (let i = 0; i < leftData.length; i += bufferSize) {
      const leftChunk = leftData.subarray(i, i + bufferSize);
      let mp3buf;
      if (useChannels === 2 && rightData) {
        const rightChunk = rightData.subarray(i, i + bufferSize);
        mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
      } else {
        mp3buf = mp3encoder.encodeBuffer(leftChunk);
      }
      
      if (mp3buf.length > 0) {
        mp3Data.push(mp3buf);
      }
    }
    
    const finalMp3 = mp3encoder.flush();
    if (finalMp3.length > 0) {
      mp3Data.push(finalMp3);
    }
    
    return new Blob(mp3Data, { type: 'audio/mpeg' });
  };

  return (
    <div className="container">
      <header className="header">
        <h1>Audio Splitter Pro</h1>
        <p>Supports AAC, M4A, MP3, WAV up to {MAX_FILE_SIZE_MB}MB</p>
      </header>

      <main>
        <section className="form-group">
          <label htmlFor="file-upload">1. Select Audio Source</label>
          <div className="file-input-wrapper">
            <input
              id="file-upload"
              type="file"
              accept=".mp3,.m4a,.aac,.wav,.ogg,.flac,.mp4,audio/*,video/mp4,audio/aac,audio/x-aac,audio/m4a,audio/x-m4a,audio/mpeg"
              onChange={handleFileChange}
            />
            <label htmlFor="file-upload" className="file-input-label-text" role="button">
              {file ? 'Replace file' : 'Choose audio file...'}
            </label>
            {file && <p className="file-name">{file.name} ({(file.size / (1024 * 1024)).toFixed(2)} MB)</p>}
          </div>
          <small style={{ color: '#6c757d', display: 'block', marginTop: '5px' }}>
            Note: 100MB AAC files can take 1-2 minutes to decode.
          </small>
        </section>

        <section className="form-group">
          <label htmlFor="duration">2. Split Duration (seconds per chunk)</label>
          <input
            id="duration"
            className="number-input"
            type="number"
            value={duration}
            onChange={(e) => setDuration(Math.max(1, Number(e.target.value)))}
            min="1"
          />
        </section>

        <button className="btn" onClick={processAudio} disabled={!file || isLoading}>
          {isLoading ? 'Processing...' : 'Split and Convert to MP3'}
        </button>

        <div className="status">
          {isLoading && (
            <div className="loading-indicator">
              <div className="spinner"></div>
              <span>{statusMessage}</span>
            </div>
          )}
          {error && <p className="error-message">{error}</p>}
        </div>

        {chunks.length > 0 && (
          <section className="results">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2>Generated Chunks</h2>
              <span style={{ fontSize: '0.9rem', color: '#666' }}>{chunks.length} parts created</span>
            </div>
            <ul className="chunk-list">
              {chunks.map((chunk, index) => (
                <li key={index} className="chunk-item">
                  <span>{chunk.fileName}</span>
                  <a href={chunk.url} download={chunk.fileName} className="btn download-btn">
                    Download
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
};

const container = window.document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);
