1. Plan Mode (Opus 4.5 Max):
    Based on our project context @docs/context, create a plan for us to implement a working mvp

    Initially, let's set up the people search with our google programmable serach. 

    and then, we will test with an amazon rekognition integration.

    let's use the mono repo approach as suggested here. 

    At this moment, ui should not be our priority, just the initial flow of the images search -> rekognition validation -> scoring
2. before that, verify your code with these contexts @aws rekognition docs
3. commit the changes we did here, and give me a summary of what we engaged on in this chat
4. igreat, but there is a pitfall, if the image we got was a photogrid, or not an actual picture of them being togehter, our system might fail, to address this, i want us to pass gemini flash as a layer to filter for actualy really, occuring image, rather than image grid. 

ideally, it that happens for earlier images in the top 5 we search for, there can be a deduction point, in the sense that

update our contex tor the necesaary part of our context for this

6. the gemini flash happens befor e the rekognition