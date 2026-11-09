import { copyProfileImage } from './profile.mjs';

export function bindController(service, bridge) {
  let avatarCopy;
  const deliver = (type, value) => bridge.deliver(type, value).catch(() => {});
  service.on('state', value => { void deliver('state', value); });
  service.on('notice', text => { void deliver('notice', text); });
  service.on('native-event', value => { void deliver('native-event', value); });
  bridge.on('reload', () => { void deliver('state', service.state()); });
  bridge.on('action', async message => {
    try {
      let result = {};
      switch (message.type) {
        case 'ready': return void deliver('state', service.state());
        case 'decoration-diagnostics': {
          const counts = Object.fromEntries(['anchors', 'marked', 'turnAuthors', 'itemAuthors', 'reactAnchors', 'conversationProps', 'roomMatches', 'messageProps', 'messageMatches', 'turnMatches', 'ownMessages'].map(key => [key, message.summary?.[key]]));
          if (Object.values(counts).every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100000)) console.log('Message decoration:', JSON.stringify(counts));
          return;
        }
        case 'profile': return service.setProfile(message.profile);
        case 'profile-image': {
          if (avatarCopy?.url !== message.url) avatarCopy = { url: message.url, promise: copyProfileImage(message.url) };
          result = await avatarCopy.promise;
          break;
        }
        case 'typing': return service.setTyping(message.roomId, message.active === true);
        case 'share': result = { roomId: await service.share(message.threadId, message.title) }; break;
        case 'invite': await service.invite(message.roomId, message.peerId); break;
        case 'accept': service.accept(message.invitationId, message.code); break;
        case 'decline': service.decline(message.invitationId); break;
        case 'send': await service.send(message.roomId, message.text, message.messageId); break;
        case 'native-request': result = await service.nativeRequest(message.roomId, message.method, message.params, message.requestId); break;
        case 'revoke': service.revoke(message.roomId, message.memberId); break;
        case 'end': service.end(message.roomId); break;
        default: throw new Error('Unknown multiplayer action.');
      }
      await deliver('result', { id: message.id, result });
    } catch (error) {
      if (message.type === 'profile-image') console.log('Profile image copy failed:', error.message);
      await deliver('result', { id: message.id, error: error.message });
    }
  });
  return deliver;
}
