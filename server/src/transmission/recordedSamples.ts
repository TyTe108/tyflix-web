// Captured from the live Transmission 4.1.2 daemon on 2026-08-24
// (rpc-version 19). These are the recorded session-stats arguments object
// and one torrent-get row, kept verbatim so 48.2's mapping tests can assert
// against a real payload field by field.
//
// The torrent `name` is a deliberate placeholder. This repo is public; do
// not put a real release name in a committed fixture.

export const SESSION_STATS_ARGUMENTS = {
  activeTorrentCount: 5,
  "cumulative-stats": {
    downloadedBytes: 3239436864045,
    filesAdded: 4944,
    secondsActive: 5395230,
    sessionCount: 9,
    uploadedBytes: 7884577247037,
  },
  "current-stats": {
    downloadedBytes: 45494641034,
    filesAdded: 31,
    secondsActive: 66267,
    sessionCount: 1,
    uploadedBytes: 27793210357,
  },
  downloadSpeed: 11419648,
  pausedTorrentCount: 5,
  torrentCount: 10,
  uploadSpeed: 1883147,
};

export const TORRENT_GET_ROW = {
  activityDate: 1782246159,
  addedDate: 1782091064,
  doneDate: 1782092105,
  downloadDir: "/Volumes/MediaStore2/torrents/tv-sonarr",
  downloadedEver: 4578806439,
  error: 0,
  errorString: "",
  eta: -1,
  hashString: "c555a15c97f99ac1347e29491be7f017fb2811d1",
  haveValid: 4578806439,
  id: 1,
  isFinished: true,
  isStalled: false,
  labels: ["tv-sonarr"],
  leftUntilDone: 0,
  metadataPercentComplete: 1.0,
  name: "Example.Show.S01E01.1080p.WEB-DL",
  peersConnected: 0,
  peersGettingFromUs: 0,
  peersSendingToUs: 0,
  percentDone: 1.0,
  queuePosition: 0,
  rateDownload: 0,
  rateUpload: 0,
  recheckProgress: 0.0,
  seedRatioLimit: 2.0,
  seedRatioMode: 0,
  sizeWhenDone: 4578806439,
  status: 0,
  totalSize: 4578806439,
  uploadedEver: 9158541625,
  uploadRatio: 2.0002028942108154,
};
