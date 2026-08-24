# Daily Routine

DAILY ROUTINE Cloudflare Worker 앱의 GitHub 운영 메모입니다.

- 운동 영상 폴더: `routine-motion/`
- Worker 앱은 Cloudflare에서 계속 실행합니다. Web Push와 Cron 때문에 GitHub Pages 단독으로는 대체하지 않습니다.
- 운동 영상은 앱이 GitHub raw 경로에서 자동으로 불러옵니다.
- R2는 사용하지 않습니다.

## 운동 영상 파일명

- `pushup.mp4`
- `pushup-close.mp4`
- `kettlebell-row.mp4`
- `kettlebell-deadlift.mp4`
- `goblet-squat.mp4`
- `reverse-lunge.mp4`
- `shoulder-press.mp4`
- `lateral-raise.mp4`
- `face-pull.mp4`
- `kettlebell-curl.mp4`
- `triceps-extension.mp4`
- `running.mp4`

Cloudflare Worker 쪽 기존 `APP_KV`, Cron, Push 설정은 그대로 유지합니다.
