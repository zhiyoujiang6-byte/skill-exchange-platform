(() => {
  'use strict';

  const gsap = window.gsap;
  let motionAllowed = false;
  let viewContext = null;
  let heroContext = null;
  let heroPlayed = false;
  let navigation = null;
  let modal = null;
  const feedbackContexts = new Map();

  const noop = () => {};
  const app = () => document.getElementById('app');

  function clearView() {
    viewContext?.revert();
    heroContext?.revert();
    viewContext = heroContext = null;
  }

  function beforeRender() {
    clearView();
    const root = app();
    for (const [element, context] of feedbackContexts) {
      if (!element.isConnected || root?.contains(element)) {
        context.revert();
        feedbackContexts.delete(element);
      }
    }
  }

  function afterRender({ route, changed = false, initial = false } = {}) {
    const root = app();
    if (!root || !motionAllowed || (!changed && !initial)) return;

    if (changed) {
      viewContext = gsap.context(() => {
        gsap.fromTo(root, { opacity: 0, y: 8 }, {
          opacity: 1, y: 0, duration: 0.25, ease: 'expo.out',
          clearProps: 'opacity,transform'
        });
      }, root);
    }

    if (route !== 'discover' || heroPlayed) return;
    const left = root.querySelector('.floating-skill.skill-one');
    const right = root.querySelector('.floating-skill.skill-two');
    const swap = root.querySelector('.swap-orb');
    if (!left || !right || !swap) return;
    heroPlayed = true;

    // Read the designed positions first; the exchange lands exactly on the CSS composition.
    const cards = [left, right].map((element, index) => ({
      element, direction: index ? 1 : -1,
      x: Number(gsap.getProperty(element, 'x')) || 0,
      rotation: Number(gsap.getProperty(element, 'rotation')) || 0
    }));
    const swapRotation = Number(gsap.getProperty(swap, 'rotation')) || 0;
    heroContext = gsap.context(() => {
      const sequence = gsap.timeline({ defaults: { ease: 'expo.out' } });
      cards.forEach(({ element, direction, x, rotation }, index) => {
        sequence.fromTo(element,
          { x: x + direction * 44, rotation: rotation + direction * 7, autoAlpha: 0.65 },
          { x, rotation, autoAlpha: 1, duration: 0.54, clearProps: 'opacity,visibility,transform' },
          index * 0.04
        );
      });
      sequence.fromTo(swap, { rotation: swapRotation - 180, scale: 0.9 }, {
        rotation: swapRotation, scale: 1, duration: 0.42,
        clearProps: 'transform'
      }, 0.16);
    }, root);
  }

  function cancelNavigation() {
    if (!navigation) return;
    const previous = navigation;
    navigation = null;
    previous.context?.revert();
  }

  function finishNavigation(record) {
    if (navigation !== record) return;
    navigation = null;
    record.context?.revert();
    record.commit();
  }

  function transition(commit) {
    cancelNavigation();
    clearView();
    const root = app();
    if (!motionAllowed || !root) {
      commit();
      return noop;
    }
    const record = { commit, context: null };
    navigation = record;
    record.context = gsap.context(() => {
      gsap.to(root, {
        opacity: 0, y: -4, duration: 0.12, ease: 'power1.in',
        onComplete: () => finishNavigation(record)
      });
    }, root);
    return () => { if (navigation === record) cancelNavigation(); };
  }

  function cancelModal() {
    if (!modal) return;
    const previous = modal;
    modal = null;
    previous.context?.revert();
  }

  function openModal(root) {
    // Opening a replacement invalidates any pending close callback for the old dialog.
    cancelModal();
    const backdrop = root?.querySelector('.modal-backdrop');
    const panel = backdrop?.querySelector('.modal');
    if (!motionAllowed || !panel) return noop;
    const record = { root, backdrop, kind: 'open', context: null };
    modal = record;
    record.context = gsap.context(() => {
      gsap.timeline({ defaults: { ease: 'expo.out' } })
        .fromTo(backdrop, { autoAlpha: 0 }, {
          autoAlpha: 1, duration: 0.18, clearProps: 'opacity,visibility'
        }, 0)
        .fromTo(panel, { y: 12, scale: 0.985 }, {
          y: 0, scale: 1, duration: 0.22, clearProps: 'transform'
        }, 0);
    }, backdrop);
    return () => { if (modal === record) cancelModal(); };
  }

  function finishModal(record) {
    if (modal !== record) return;
    modal = null;
    record.context?.revert();
    record.backdrop.remove();
    // Never let an old exit callback clear or unlock a newly opened dialog.
    if (!record.root.querySelector('.modal-backdrop')) record.done?.(record.backdrop);
  }

  function closeModal(root, done = noop) {
    const backdrop = root?.querySelector('.modal-backdrop');
    if (modal?.kind === 'close' && modal.backdrop === backdrop) return modal.cancel;
    cancelModal();
    if (!backdrop) {
      done();
      return noop;
    }
    const record = { root, backdrop, done, kind: 'close', context: null, cancel: null };
    record.cancel = () => { if (modal === record) cancelModal(); };
    modal = record;
    if (!motionAllowed) {
      finishModal(record);
      return noop;
    }
    const panel = backdrop.querySelector('.modal');
    record.context = gsap.context(() => {
      const sequence = gsap.timeline({ onComplete: () => finishModal(record) });
      if (panel) sequence.to(panel, { y: 6, scale: 0.99, duration: 0.13, ease: 'power1.in' }, 0);
      sequence.to(backdrop, { autoAlpha: 0, duration: 0.13, ease: 'power1.in' }, 0);
    }, backdrop);
    return record.cancel;
  }

  function feedback(element) {
    if (!element || !motionAllowed) return noop;
    feedbackContexts.get(element)?.revert();
    const context = gsap.context(() => {
      gsap.fromTo(element, { scale: 0.97 }, {
        scale: 1, duration: 0.15, ease: 'expo.out', clearProps: 'transform',
        onComplete: () => {
          if (feedbackContexts.get(element) === context) {
            context.revert();
            feedbackContexts.delete(element);
          }
        }
      });
    }, element);
    feedbackContexts.set(element, context);
    return () => {
      if (feedbackContexts.get(element) === context) {
        context.revert();
        feedbackContexts.delete(element);
      }
    };
  }

  window.SkillMotion = { beforeRender, afterRender, transition, openModal, closeModal, cancelModal, feedback };

  // MatchMedia owns preference changes; action contexts live outside its callback.
  // Default content remains visible, including when GSAP fails to load.
  if (gsap?.matchMedia) {
    const preferences = gsap.matchMedia();
    preferences.add({
      motion: '(prefers-reduced-motion: no-preference)',
      reduced: '(prefers-reduced-motion: reduce)'
    }, context => {
      motionAllowed = Boolean(context.conditions.motion && !context.conditions.reduced);
      if (!motionAllowed) {
        clearView();
        for (const feedbackContext of feedbackContexts.values()) feedbackContext.revert();
        feedbackContexts.clear();
        if (modal?.kind === 'close') finishModal(modal);
        else cancelModal();
        if (navigation) finishNavigation(navigation);
      }
    });
  }
})();
