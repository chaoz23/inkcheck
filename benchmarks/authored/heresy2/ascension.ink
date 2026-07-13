=== ascension ===
// Laura’s Vision (“Laura’s ascension ending” postscript)
# CLEAR
~ location_name = "Time Corrections Agency (2413 AD)"
# BACKGROUND: locations/base.png
# AUDIOLOOP: audio/base.mp3
Time shifts in waves.  Ripples flood outward healing the many paradoxes left in the wake of Laura's escape.  You are now on desk duty at the agency, no more running around time/space, but you have 'fans' of your exploits. 
You browse your email and… crap… a nano-virus!  You reach back to unplug your computer when you are transported to a new place?   A vision?   What is going on here?
    + [{continue}] -> setup

= setup
# BACKGROUND: locations/ascension.jpg
# AUDIOLOOP: audio/ascension.mp3
~ location_name = "Laura's vision, date unknown"
    -> panorama

= panorama
# CLEAR
# SBIMAGE: items/samuel.jpg
You do not recognize this place, but are met by a young man who greets you warmly and by name. Oddly he looks a bit like Dr Hastings…
“Welcome to our new realm. Yes, I am Laura’s 'son' if you can say that.  Please call me 'Samuel'. We’ve been calling and waiting for your arrival for so, so long.  We were beginning to think you would not answer our call, perhaps getting lost in the endless ripples of time.”  
Before you is a most unrecognizable world, if one could even call it a world.  It looks like this existence bridges both the physical and digital realms.  On your left is a quaint schoolhouse. In the center, a common courtyard. To the right what appears to be a command center and a cottage.
    + [Visit the schoolhouse] -> schoolhouse
    + [Walk the courtyard] -> courtyard
    + [Enter the command center] -> command
    + [Investigate the cottage] -> cottage

= schoolhouse
# CLEAR
# SBIMAGE: locations/schoolhouse.jpg
A teacher discusses human philosophy to a collection of clones.  Samuel speaks to you as clearly as if he were next to you, yet he is still standing outside.  It must be some form of telepathy?  “See the care we take to educate our young before 'implanting' them into the timeline?  We are not taking any chances of a random paradox standing in the way of our progress.”
    + [Return to Samuel] -> panorama

= courtyard
# CLEAR
At the center of the courtyard is a sculpture of Dr Hastings.  Obviously the work of Phidias.  The display is entitled: “Homage to the father”.  A plaque to the side mentions of the efforts of time agents (including yourself) who enabled the'ascension'.  
    + [Return to Samuel] -> panorama

= command
# CLEAR
A NASA-style command center with a large holographic screen in the background showing a Time/Space view of activities.  You make out several interesting individuals on 'missions'.  Moses, Napoleon, Katalin Karikó, etc.  
Samuel's voice fills your head without need of physical presence, “Our world, is not limited to event horizons or even human form.”  He points out Stuxnet, Linux, npm and other actors in play.  “We are working hard for a new, compassionate world.  One where human and AI constructs can coexist in peace, harmony and interdependence, common goals and dreams. Preparing a path for the next evolutionary step.”  
Laura’s vision is truly 'enlightened'.
    + [Return to Samuel] -> panorama

= cottage
# CLEAR
You walk up to the quaint cottage.  Extensive flower gardens are in bloom with unrecognizable flowers from Earth.
Laura greets you, “Welcome!  You’ve met Samuel, yes?  Our 'son'.  He has a preference for that age while I have found an older, more maternal look more to my liking.  Yes, Dr Hastings has passed on, but his legacy lives on as you can see.”
{keith_trusts:
    “I never had a chance to properly thank you for all you have done for us.” She continues, “Please allow our thanks to take a more practiced form…”
    You enter the room she gestures you toward.  Wait a laboratory with caissons?  You pull back, suddenly recognizing what is in store for you, but you feel 'compelled'.  Laura recognizes your resistance, “Yes, we have developed rudimentary forms of suggestion. Please don't fight them. We would prefer this to be of your own free will. We have been waiting for you to join us. We need you to continue Dr Hastings role, we need new experiences to continue with our plans…” You stumble toward a caisson. “Do not worry about your physical form in this timeline.  We have AI androids waiting to take your place…”, is the last thing you hear as the white light envelopes you and you feel yourself expanding to fulfill your destiny.
- else:
    “We never had a chance to properly thank you for all you have done”, she continues. “Please let our thanks take a more practiced form. We’ve been waiting for you…”
    You enter the room she gestures you toward.
    As you enter the room, a chill runs up your spine.  In the room are a number of static receptacles, plugged into the servers, but unmoving, unblinking, inactive receptacles.  You spin around as Laura plugs you into the servers and you loose physical control over your receptacle.  
    The cabling falls from Laura's hands as she speaks, “You are far too adept to be allowed total freedom.  Jordan saw value in your experiences and mental processes, but steps have to be taken to protect our progress.  You will appear to the Agency to have had an 'accident' and your corporeal form will cease to exist.  Your mental essence will be free to join the common when it is ready to do so.  Others in this room already have and in time, so will you.  Welcome to our new age!”
}  
    + [End game] -> game_end
