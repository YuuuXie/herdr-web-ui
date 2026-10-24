### Maintenance
- The push relay drops an Android phone's endpoints when FCM calls its token invalid, as it already
  did for an iPhone's token Apple calls invalid, and `push-relay/test-push.ts` checks a real push
  through FCM too. The relay's tests run in Fast checks instead of a workflow of their own.
