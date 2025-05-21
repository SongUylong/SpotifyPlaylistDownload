require('dotenv').config();
const express = require("express");
const path = require("path");
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const SpotifyWebApi = require('spotify-web-api-node');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files (HTML, CSS, etc.)
app.use(express.static(path.join(__dirname, "public")));

// Parse JSON bodies
app.use(express.json());

// Configure environment
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const DOWNLOADED_SONGS_FILE = path.join(__dirname, 'downloaded_songs.json');
const DELAY_BETWEEN_TRACKS = 10; // 10 secondsn

// Initialize Spotify API
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

// Sanitize filenames
function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '-').trim();
}

// Spotify Authentication
async function authenticateSpotify() {
  try {
    const { body } = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(body.access_token);
  } catch (err) {
    console.error('Spotify authentication failed:', err.message);
    throw err;
  }
}

// Extract Spotify Playlist ID
function extractPlaylistId(url) {
  const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

// Get Playlist Tracks
async function getPlaylistTracks(playlistId) {
  try {
    const { body } = await spotifyApi.getPlaylistTracks(playlistId);
    return body.items.map((item) => ({
      name: item.track.name,
      artist: item.track.artists.map((artist) => artist.name).join(' '),
    }));
  } catch (err) {
    console.error('Failed to fetch Spotify playlist tracks:', err.message);
    throw err;
  }
}

// YouTube Search
async function searchYoutube(query) {
  try {
    const { videos } = await yts(query);
    return videos.length > 0 ? videos[0].url : null;
  } catch (err) {
    console.error('Failed to search YouTube:', err.message);
    return null;
  }
}

// Download and Convert Audio
async function downloadAudio(url, trackName) {
  const sanitizedTrackName = sanitizeFilename(trackName);
  const outputPath = path.join(DOWNLOAD_DIR, `${sanitizedTrackName}.mp3`);

  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const audioStream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio' });

    ffmpeg()
      .setFfmpegPath(ffmpegStatic)
      .input(audioStream)
      .audioBitrate(320)
      .save(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err));
  });
}

// Load downloaded songs from file
function loadDownloadedSongs() {
  if (fs.existsSync(DOWNLOADED_SONGS_FILE)) {
    const data = fs.readFileSync(DOWNLOADED_SONGS_FILE, 'utf8');
    return JSON.parse(data);
  }
  return [];
}

// Save downloaded songs to file
function saveDownloadedSongs(songs) {
  fs.writeFileSync(DOWNLOADED_SONGS_FILE, JSON.stringify(songs, null, 2), 'utf8');
}

// Check if a song already exists
function isSongDownloaded(songName, downloadedSongs) {
  return downloadedSongs.includes(songName);
}

// Endpoint to handle download requests for Spotify playlists
app.post("/download", async (req, res) => {
  const { playlistUrl } = req.body;

  if (!playlistUrl) {
    return res.status(400).json({ error: "Playlist URL is required" });
  }

  try {
    console.log(`Starting download for playlist: ${playlistUrl}`);

    await authenticateSpotify();
    const playlistId = extractPlaylistId(playlistUrl);
    const tracks = await getPlaylistTracks(playlistId);

    if (tracks.length === 0) {
      return res.status(404).json({ error: "No tracks found in the playlist." });
    }

    // Create a ZIP archive
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.setHeader('Content-Disposition', 'attachment; filename="playlist.zip"');
    res.setHeader('Content-Type', 'application/zip');
    archive.pipe(res);

    for (const track of tracks) {
      const songName = `${track.artist} - ${track.name}`;
      const query = `${track.name} ${track.artist}`;
      const youtubeUrl = await searchYoutube(query);

      if (!youtubeUrl) {
        console.log(`No results found for: ${query}`);
        continue;
      }

      console.log(`Downloading: ${query}`);
      const sanitizedTrackName = sanitizeFilename(songName);
      const outputPath = path.join(DOWNLOAD_DIR, `${sanitizedTrackName}.mp3`);

      await new Promise((resolve, reject) => {
        const audioStream = ytdl(youtubeUrl, {
          filter: "audioonly",
          quality: "highestaudio",
        });

        ffmpeg()
          .setFfmpegPath(ffmpegStatic)
          .input(audioStream)
          .audioBitrate(320)
          .save(outputPath)
          .on('end', () => {
            archive.file(outputPath, { name: `${sanitizedTrackName}.mp3` });
            resolve();
          })
          .on('error', (err) => reject(err));
      });

      // Avoid rate-limiting
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_TRACKS));
    }

    // Finalize the ZIP archive
    archive.finalize();
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: "Failed to process the playlist." });
  }
});

// Endpoint to list all downloaded files
app.get("/files", (req, res) => {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    return res.status(404).json({ error: "No downloaded files found." });
  }

  const files = fs.readdirSync(DOWNLOAD_DIR);
  res.json({ files });
});

// Endpoint to download a specific file
app.get("/files/:filename", (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(DOWNLOAD_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found." });
  }

  res.download(filePath, filename, (err) => {
    if (err) {
      console.error("Error while sending file:", err.message);
      res.status(500).send("Could not download the file.");
    }
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});