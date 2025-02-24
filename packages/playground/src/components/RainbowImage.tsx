import { FunctionComponent } from 'react';
import styles from './RainbowImage.module.css';


const RainbowImage:FunctionComponent = () => {
  	return (
    		<img className={styles.rainbowIcon} alt="" src="./src/assets/rainbow.svg" />);
};

export default RainbowImage;
