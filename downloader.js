require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const SpotifyWebApi = require('spotify-web-api-node');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const DOWNLOADED_SONGS_FILE = path.join(__dirname, 'downloaded_songs.json');

// Configure environment
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const DELAY_BETWEEN_TRACKS = 10000; // 10 seconds

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

// Main Function
async function main(playlistUrl) {
    try {
      await authenticateSpotify();
      const playlistId = extractPlaylistId(playlistUrl);
      const tracks = await getPlaylistTracks(playlistId);
  
      // Load the list of already downloaded songs
      const downloadedSongs = loadDownloadedSongs();
  
      for (const track of tracks) {
        try {
          const songName = `${track.artist} - ${track.name}`;
  
          // Skip if the song is already downloaded
          if (isSongDownloaded(songName, downloadedSongs)) {
            console.log(`Skipping duplicate: ${songName}`);
            continue;
          }
  
          const query = `${track.name} ${track.artist}`;
          const youtubeUrl = await searchYoutube(query);
  
          if (!youtubeUrl) {
            console.log(`No results found for: ${query}`);
            continue;
          }
  
          console.log(`Downloading: ${query}`);
          await downloadAudio(youtubeUrl, songName);
          console.log(`Downloaded: ${query}`);
  
          // Add the song to the list of downloaded songs
          downloadedSongs.push(songName);
          saveDownloadedSongs(downloadedSongs);
  
          // Avoid rate-limiting
          await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_TRACKS));
        } catch (err) {
          console.error(`Error downloading ${track.name}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Fatal error:', err.message);
      throw err;
    }
  }
module.exports = { main };
