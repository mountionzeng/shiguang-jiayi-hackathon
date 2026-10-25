Page({ onLoad(options: {storyId?: string} = {}) { wx.redirectTo({url: '/pages/room/room?storyId=' + encodeURIComponent(options.storyId || '')}); } });
